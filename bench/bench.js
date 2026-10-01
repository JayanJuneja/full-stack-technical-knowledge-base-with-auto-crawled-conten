/**
 * Benchmark: search index build/query speed, end-to-end HTTP search latency, and
 * crawler ingest throughput against a local fixture site. All data is synthetic and
 * generated with a seeded PRNG, so runs are comparable. Prints a JSON list as the
 * last line of stdout.
 */
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { SearchIndex } from '../server/search.js';
import { createContext } from '../server/context.js';
import { rebuildIndex } from '../server/indexing.js';

// ---------- synthetic corpus ----------
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const BASE_WORDS = (
  'kubernetes docker postgres index query cache latency throughput deploy rollback service cluster node pod replica ' +
  'shard partition consumer producer queue topic offset schema migration backup restore secret token auth oauth ' +
  'session cookie header request response timeout retry circuit breaker metric trace log alert incident runbook ' +
  'pipeline build artifact release version branch merge review test coverage benchmark profile memory cpu disk ' +
  'network dns tls certificate proxy gateway ingress load balancer autoscale config flag rollout canary feature'
).split(' ');
// Extend with generated jargon so the vocabulary is realistically large (~5k terms).
const VOCAB = [...BASE_WORDS];
for (let i = 0; VOCAB.length < 5000; i++) VOCAB.push(`${BASE_WORDS[i % BASE_WORDS.length]}${Math.floor(i / BASE_WORDS.length)}x`);
// Zipf-ish sampling: low ranks are much more common.
const word = () => VOCAB[Math.min(VOCAB.length - 1, Math.floor(Math.pow(rand(), 2.2) * VOCAB.length))];
const sentence = (n) => Array.from({ length: n }, word).join(' ');

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r2 = (x) => Math.round(x * 100) / 100;
const results = [];

// ---------- 1. index build + in-process query latency ----------
const N_DOCS = 20_000;
const docs = Array.from({ length: N_DOCS }, (_, i) => ({
  id: `${i % 2 ? 'item' : 'page'}:${i}`,
  title: sentence(4 + Math.floor(rand() * 6)),
  body: sentence(80 + Math.floor(rand() * 220)),
  type: i % 2 ? 'item' : 'page',
}));
const index = new SearchIndex();
let t0 = performance.now();
for (const d of docs) index.add(d.id, d);
const buildMs = performance.now() - t0;
results.push({ name: 'index build throughput', value: Math.round(N_DOCS / (buildMs / 1000)), unit: 'docs/s', context: `${N_DOCS.toLocaleString()} synthetic docs, ~190 words each, 5k-term Zipf vocabulary` });

const queries = Array.from({ length: 1000 }, (_, i) => sentence(1 + (i % 3)) + (i % 5 === 0 ? ' ' : ''));
for (const q of queries.slice(0, 50)) index.search(q); // warm-up
const lat = queries.map((q) => {
  const s = performance.now();
  index.search(q, { limit: 20 });
  return performance.now() - s;
});
results.push({ name: 'p50 search latency (in-process)', value: r2(percentile(lat, 50)), unit: 'ms', context: `1,000 queries of 1-3 terms (prefix expansion on) over ${N_DOCS.toLocaleString()} docs` });
results.push({ name: 'p95 search latency (in-process)', value: r2(percentile(lat, 95)), unit: 'ms', context: `1,000 queries of 1-3 terms (prefix expansion on) over ${N_DOCS.toLocaleString()} docs` });

// ---------- 2. end-to-end HTTP search latency ----------
const ctx = await createContext({ databaseUrl: ':memory:', crawler: { delayMs: 0 } });
const now = new Date().toISOString();
for (let i = 0; i < 5000; i++) {
  await ctx.db.query(
    `INSERT INTO pages (slug, title, body, tags, version, created_at, updated_at) VALUES ($1, $2, $3, '', 1, $4, $4)`,
    [`p-${i}`, docs[i].title, docs[i].body, now],
  );
}
t0 = performance.now();
await rebuildIndex(ctx.db, ctx.index);
const rebuildMs = performance.now() - t0;
results.push({ name: 'startup index rebuild from SQLite', value: Math.round(rebuildMs), unit: 'ms', context: '5,000 pages loaded from node:sqlite and indexed' });

const appServer = await new Promise((r) => {
  const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
});
const appBase = `http://127.0.0.1:${appServer.address().port}`;
const reg = await (
  await fetch(`${appBase}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bench', password: 'bench-password' }) })
).json();
const auth = { authorization: `Bearer ${reg.token}` };
const httpLat = [];
for (const q of queries.slice(0, 500)) {
  const s = performance.now();
  const res = await fetch(`${appBase}/api/search?q=${encodeURIComponent(q)}&limit=20`, { headers: auth });
  await res.json();
  httpLat.push(performance.now() - s);
}
results.push({ name: 'p95 HTTP search latency', value: r2(percentile(httpLat, 95)), unit: 'ms', context: '500 sequential GET /api/search on localhost incl. auth lookup, 5,000 pages indexed' });

// ---------- 3. crawler throughput against a local fixture site ----------
const SITE_PAGES = 300;
const FEED_ITEMS = 1000;
const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Bench</title>${Array.from(
  { length: FEED_ITEMS },
  (_, i) => `<item><title>Post ${i} ${sentence(5)}</title><link>http://feed.local/post/${i}</link><description>&lt;p&gt;${sentence(120)}&lt;/p&gt;</description></item>`,
).join('')}</channel></rss>`;
const pageHtml = Array.from({ length: SITE_PAGES }, (_, i) => {
  const links = [1, 2, 7, 31].map((k) => `<a href="/docs/p${(i * k + k) % SITE_PAGES}">next</a>`).join(' ');
  return `<html><head><title>Doc ${i}: ${sentence(4)}</title></head><body><nav>${links}</nav><main><h1>Doc ${i}</h1><p>${sentence(250)}</p></main></body></html>`;
});
const fixture = createServer((req, res) => {
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private/\n');
  if (req.url === '/feed.xml') {
    if (req.headers['if-none-match'] === '"v1"') {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('etag', '"v1"');
    return res.end(feedXml);
  }
  const m = req.url.match(/^\/docs\/p(\d+)$/);
  if (m && pageHtml[Number(m[1])]) {
    res.setHeader('content-type', 'text/html');
    return res.end(pageHtml[Number(m[1])]);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const fx = `http://127.0.0.1:${fixture.address().port}`;
const mkSource = (name, url, kind, max) =>
  ctx.db.one(`INSERT INTO sources (name, url, kind, max_pages, interval_minutes, enabled, created_at) VALUES ($1, $2, $3, $4, 60, 1, $5) RETURNING *`, [name, url, kind, max, now]);

const siteSrc = await mkSource('bench site', `${fx}/docs/p0`, 'site', SITE_PAGES);
t0 = performance.now();
const siteStats = await ctx.crawler.crawlSource(siteSrc);
const siteMs = performance.now() - t0;
results.push({ name: 'site crawl throughput', value: Math.round(siteStats.added / (siteMs / 1000)), unit: 'pages/s', context: `BFS crawl of ${siteStats.added} local HTML pages (fetch, robots check, extract, upsert, index), no politeness delay` });

const feedSrc = await mkSource('bench feed', `${fx}/feed.xml`, 'rss', 1);
t0 = performance.now();
const feedStats = await ctx.crawler.crawlSource(feedSrc);
const feedMs = performance.now() - t0;
results.push({ name: 'RSS ingest throughput', value: Math.round(feedStats.added / (feedMs / 1000)), unit: 'items/s', context: `${feedStats.added} items from one local RSS feed parsed, hashed, stored and indexed` });

const fresh = await ctx.db.one('SELECT * FROM sources WHERE id = $1', [feedSrc.id]);
t0 = performance.now();
const again = await ctx.crawler.crawlSource(fresh);
const recrawlMs = performance.now() - t0;
if (!again.notModified) throw new Error('expected 304 on re-crawl');
results.push({ name: 'unchanged feed re-crawl', value: r2(recrawlMs), unit: 'ms', context: `conditional GET (ETag -> 304) skips re-parsing ${FEED_ITEMS} items` });

const siteSrc2 = await ctx.db.one('SELECT * FROM sources WHERE id = $1', [siteSrc.id]);
t0 = performance.now();
const siteAgain = await ctx.crawler.crawlSource(siteSrc2);
const siteAgainMs = performance.now() - t0;
results.push({ name: 'unchanged site re-crawl', value: Math.round(siteAgainMs), unit: 'ms', context: `${siteAgain.unchanged} pages re-fetched, content-hash match so no DB writes or re-indexing` });

appServer.close();
fixture.close();
await ctx.db.close();

for (const r of results) console.log(`${r.name.padEnd(36)} ${String(r.value).padStart(10)} ${r.unit}`);
console.log(JSON.stringify(results));
