# CrawlWiki HTTP API

All endpoints are JSON. Apart from `register`, `login` and `health`, every endpoint needs
`Authorization: Bearer <token>` (you get the token from register/login). Errors look like
`{"error": "message"}` and use standard status codes (400 validation, 401 not logged in,
403 wrong role, 404, 409 conflict).

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{username, password}` | First account becomes `admin`; later ones are `editor`. Returns `{user, token}`. Set `ALLOW_REGISTRATION=false` to let only admins create accounts after that. |
| POST | `/api/auth/login` | `{username, password}` | Returns `{user, token}`. Sessions last 7 days. |
| POST | `/api/auth/logout` | – | Revokes the current token. |
| GET | `/api/auth/me` | – | `{user}` |

Roles: **editor** can read and search everything, create pages and edit them.
**admin** can also delete pages and manage crawl sources.

## Pages (user-authored docs)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/pages[?tag=t]` | List, most recently updated first. |
| GET | `/api/pages/:slug` | `{page}` with `version`, `author`, `updated_by`. |
| POST | `/api/pages` | `{title, body?, tags?, slug?}`. The slug comes from the title and gets `-2`, `-3`… if already taken. |
| PUT | `/api/pages/:slug` | `{version, title?, body?, tags?}`. `version` is the version you started editing. If someone saved after that, you get **409** with `{current}` and nothing is overwritten. |
| DELETE | `/api/pages/:slug` | admin only |
| GET | `/api/pages/:slug/revisions` | Full revision history, newest first. |

Page bodies are Markdown (headings, lists, code fences, links, `[[wiki-links]]`). They are
rendered by `shared/markdown.js`, which escapes everything first.

## Search

`GET /api/search?q=...&type=page|item&limit=20&offset=0`

```json
{ "query": "visibility timeout", "total": 2,
  "results": [{ "id": "item:5", "type": "item", "title": "Configuration - Acme Queue Docs",
                "score": 4.21, "snippet": "…visibility_timeout – seconds before…",
                "meta": { "itemId": 5, "url": "http://…", "sourceName": "Acme Queue docs" } }] }
```

Page results have `meta.slug`. Crawled results have `meta.itemId`, `meta.url` and `meta.sourceName`.

## Crawl sources and items

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sources` | Includes `item_count`, `last_crawled_at`, `last_status`, `last_error`. |
| POST | `/api/sources` | admin. `{name, url, kind: "rss"|"site", max_pages?, interval_minutes?}` |
| DELETE | `/api/sources/:id` | admin. Also deletes the source's items and removes them from search. |
| POST | `/api/sources/:id/crawl` | admin. Crawls right away and returns `{stats: {fetched, added, updated, unchanged, skipped, notModified, errors}}`. |
| GET | `/api/items/:id` | One crawled document (`title`, `url`, `content`, `published_at`, `source_name`). |
