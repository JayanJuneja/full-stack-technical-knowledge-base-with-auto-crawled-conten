# CrawlWiki

CrawlWiki is a small wiki for technical documentation, in the style of Confluence. Your team writes
pages in Markdown, and a background crawler pulls in external **RSS/Atom feeds** and
**documentation websites**. Both kinds of content go into **one search index**, so a single
query finds your runbook and the vendor's docs page next to each other.

Stack: React (Vite) frontend, Express API, PostgreSQL (Docker) or SQLite (local/tests),
GitHub Actions CI, and a multi-stage Docker image.

## Why it's interesting

- **The crawler follows the usual crawling etiquette.** It reads `robots.txt` (user-agent
  groups, Allow/Disallow, `*`/`$` wildcards, longest match wins) and honours
  `<meta name="robots" content="noindex/nofollow">` and `rel="nofollow"`. Feeds use conditional
  GET, so an unchanged feed comes back as `ETag → 304` and nothing is re-parsed. Content is
  SHA-256 hashed, so unchanged pages cause no DB writes and no re-indexing. Requests have
  timeouts and a size cap, and there's a configurable delay between requests. Site crawls are
  breadth-first, stay on the same origin and only follow URLs under the start URL's path.
- **Search is hand-written.** It's a BM25 inverted index with extra weight on titles (a simple
  BM25F variant), light stemming, tokenization that understands terms like `node.js` and
  `max_pages`, prefix expansion of the last word for search-as-you-type, filters by type, and
  snippets. Every write updates it, and it's rebuilt from the DB at startup.
- **Wiki behaviour you'd expect.** Every edit is kept as a revision. Saves use optimistic
  locking: two people editing the same page can't silently overwrite each other, and the second
  save gets a 409 with the current version. Wiki links use `[[page-slug]]`. The Markdown
  renderer is XSS-safe.
- **One SQL codebase, two databases.** The app writes all SQL with Postgres-style `$1`
  placeholders against a ~90-line adapter. In production it uses `pg` with PostgreSQL. Locally,
  in tests and in the benchmark it uses Node's built-in `node:sqlite`, so you can try it with
  nothing installed except Node.

## Architecture

```
React SPA (web/) ──fetch /api──▶ Express (server/app.js) ──▶ db.js adapter ──▶ PostgreSQL | SQLite
                                     │   ▲                                         ▲
                                     ▼   │ index updates on every write            │ upserts
                                 SearchIndex (BM25, in memory) ◀── Crawler (server/crawler/) ──▶ RSS / doc sites
```

- `server/schema.sql`: one portable schema with `users`, `sessions`, `pages`,
  `page_revisions`, `sources` and `crawled_items`.
- `server/auth.js`: scrypt password hashes and random bearer tokens. Only a SHA-256 hash of
  each token is stored. Roles are `admin` and `editor`, and the first user to register becomes
  admin.
- `server/app.js`: REST API for auth, pages, revisions, search, sources and items. It also
  serves the built SPA. See [docs/API.md](docs/API.md).
- `server/crawler/`: `parse.js` (RSS/Atom/HTML extraction, no dependencies), `robots.js`, and
  `crawler.js` (fetch policy, BFS, upserts, scheduler).
- `server/search.js` + `server/indexing.js`: the BM25 index and the code that maps DB rows to
  index documents.
- `shared/markdown.js`: the safe Markdown renderer, used by the UI and covered by the tests.
- `web/src/`: hash-routed React UI with live search (debounced, highlighted snippets, tabs for
  All/Pages/Crawled), a page view, an editor with preview, revision history, a crawled-item view
  and a source admin screen.

## Run it locally (Node ≥ 22.13, no database needed)

```bash
npm install
npm run build                       # build the React app into web/dist
ADMIN_PASSWORD=choose-one npm run seed   # admin user, 3 sample pages, 2 sample sources
npm start                           # http://localhost:3000  (SQLite file in data/)
```

Log in as `admin`, open **Sources** and click **Crawl now**. The two sample sources point at the
bundled offline fixtures in `samples/` (an RSS feed and a three-page docs site), which the app
itself serves. Try searching for `visibility timeout` or `docker images`. The scheduler also
crawls due sources every `CRAWL_EVERY_SECONDS` (default 60).

For frontend development, run `npm run dev:server` and `npm run dev:web` (Vite on :5173,
which proxies `/api` to :3000).

## Run with Docker + PostgreSQL

```bash
docker compose up --build
docker compose exec app node server/seed.js   # optional sample data
```

Configuration (environment variables): `DATABASE_URL`, `PORT`, `ALLOW_REGISTRATION`,
`CRAWL_EVERY_SECONDS` (0 turns background crawling off) and `CRAWL_DELAY_MS`.

## Tests

```bash
npm test
```

There are 29 tests using `node:test`, against the real app on an ephemeral port with in-memory
SQLite:

- auth flows and role checks
- page CRUD, slug collisions, revisions, 409 on conflicting edits
- search staying in sync after updates and deletes
- RSS/Atom/HTML parsing, robots.txt rules, Markdown XSS escaping
- a crawler suite that runs against a local fixture web server: ETag/304, hash-based
  change detection, BFS scope, robots blocking, noindex, `max_pages`, error recording,
  interval scheduling

To run the same suite on PostgreSQL, set `TEST_DATABASE_URL=postgres://…`.
`.github/workflows/ci.yml` runs a SQLite + PostgreSQL matrix, builds the frontend, runs the
benchmark, then builds the Docker image (and pushes it to GHCR on `main`). *Note: the
PostgreSQL path is written for and wired into CI, but during development it was only run
locally against SQLite.*

## Benchmark

```bash
npm run bench
```

Everything is synthetic and seeded (Zipf-distributed technical vocabulary). The crawler
numbers come from a local HTTP fixture server, so they measure parsing/storage/indexing
overhead, not network speed. Results from one run on a laptop (Apple Silicon, Node 26):

| Metric | Value | Context |
|---|---|---|
| Index build throughput | 15,084 docs/s | 20,000 docs, ~190 words each |
| p50 search latency (in-process) | 1.00 ms | 1,000 queries of 1–3 terms, 20k docs, prefix expansion on |
| p95 search latency (in-process) | 8.09 ms | same |
| Startup index rebuild from SQLite | 266 ms | 5,000 pages |
| p95 HTTP search latency | 2.12 ms | 500 sequential `GET /api/search`, 5k pages, incl. auth lookup |
| Site crawl throughput | 4,116 pages/s | BFS over 300 local HTML pages, no politeness delay |
| RSS ingest throughput | 13,634 items/s | 1,000-item feed parsed, hashed, stored, indexed |
| Unchanged feed re-crawl | 0.83 ms | ETag → 304, nothing re-parsed |
| Unchanged site re-crawl | 36 ms | 300 pages re-fetched, all hash-matched, no writes |

## Limitations (on purpose, given the scope)

- The search index is in memory and lives in one process. That's fine for thousands to tens
  of thousands of documents. Running several API replicas would need a shared index
  (e.g. Postgres `tsvector` or OpenSearch).
- Feed and HTML extraction is regex-based and forgiving, not a full XML/DOM parser. Pages
  rendered by JavaScript aren't executed.
- The Markdown support covers a deliberately small subset (no tables or images).
- Tokens are bearer tokens kept in `localStorage`. A production deployment would add HTTPS,
  rate limiting on login, and probably SSO.
