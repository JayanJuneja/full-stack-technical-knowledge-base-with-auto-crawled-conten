import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startFixtureServer } from './helpers.js';

// A tiny "external" website: robots.txt, an RSS feed with ETag support, and a doc site.
const state = { feedVersion: 1, requests: [] };
const feedXml = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Ops</title>
  <item><title>Zero-downtime migrations</title><link>http://ext/ops/migrations</link>
    <description>Expand and contract schema changes in ${state.feedVersion === 1 ? 'two' : 'three'} phases.</description></item>
  <item><title>Feature flags</title><link>http://ext/ops/flags</link><description>Ship dark, release gradually.</description></item>
</channel></rss>`;

const html = (title, body, links = []) =>
  `<html><head><title>${title}</title></head><body><nav>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</nav><main>${body}</main></body></html>`;

const site = {
  '/docs/': html('Docs home', '<p>Welcome to the Widget docs.</p>', ['install', 'config', '/docs/secret/keys', '/blog/post', 'https://elsewhere.test/x']),
  '/docs/install': html('Install', '<p>Install the widget with the flux capacitor.</p>', ['/docs/', 'hidden']),
  '/docs/config': html('Config', '<p>Set retries.</p>', ['/docs/install']),
  '/docs/hidden': '<html><head><meta name="robots" content="noindex"><title>Hidden</title></head><body><main>Not indexed draft</main></body></html>',
  '/docs/secret/keys': html('Keys', '<p>Should be blocked by robots</p>'),
  '/blog/post': html('Blog', '<p>Out of scope</p>'),
};

let fixture;
let app;
let token;

before(async () => {
  fixture = await startFixtureServer((req, res) => {
    state.requests.push(req.url);
    if (req.url === '/robots.txt') {
      res.end('User-agent: *\nDisallow: /docs/secret/\n');
    } else if (req.url === '/feed.xml') {
      const etag = `"v${state.feedVersion}"`;
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      res.setHeader('etag', etag);
      res.setHeader('content-type', 'application/rss+xml');
      res.end(feedXml());
    } else if (site[req.url.split('?')[0]]) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(site[req.url.split('?')[0]]);
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  app = await startApp();
  token = (await app.api('POST', '/api/auth/register', { body: { username: 'admin', password: 'admin-password' } })).body.token;
});

after(async () => {
  await app.close();
  await fixture.close();
});

async function addSource(body) {
  const r = await app.api('POST', '/api/sources', { token, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.source;
}

test('RSS crawl ingests items, then uses conditional GET and content hashing', async () => {
  const src = await addSource({ name: 'Ops feed', url: `${fixture.base}/feed.xml`, kind: 'rss' });

  let { stats } = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body;
  assert.deepEqual([stats.added, stats.updated, stats.unchanged, stats.errors.length], [2, 0, 0, 0]);

  const hits = await app.api('GET', '/api/search?q=contract%20schema', { token });
  assert.equal(hits.body.results[0].type, 'item');
  assert.equal(hits.body.results[0].meta.sourceName, 'Ops feed');
  const item = await app.api('GET', `/api/items/${hits.body.results[0].meta.itemId}`, { token });
  assert.equal(item.body.item.url, 'http://ext/ops/migrations');

  // Same ETag -> 304, nothing re-processed.
  stats = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body.stats;
  assert.equal(stats.notModified, true);

  // Feed changes one item -> 1 updated, 1 unchanged; search reflects new text.
  state.feedVersion = 2;
  stats = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body.stats;
  assert.deepEqual([stats.added, stats.updated, stats.unchanged], [0, 1, 1]);
  assert.equal((await app.api('GET', '/api/search?q=three%20phases', { token })).body.results[0].title, 'Zero-downtime migrations');

  const sources = (await app.api('GET', '/api/sources', { token })).body.sources;
  const row = sources.find((s) => s.id === src.id);
  assert.equal(row.item_count, 2);
  assert.match(row.last_status, /1 updated/);
});

test('site crawl is BFS within path prefix, honours robots.txt and noindex', async () => {
  const src = await addSource({ name: 'Widget docs', url: `${fixture.base}/docs/`, kind: 'site', max_pages: 50 });
  state.requests = [];
  const { stats } = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body;

  assert.equal(stats.added, 3, 'home, install, config (hidden is noindex)');
  assert.equal(stats.skipped, 1, 'secret blocked by robots');
  assert.ok(!state.requests.includes('/docs/secret/keys'), 'blocked page never requested');
  assert.ok(!state.requests.includes('/blog/post'), 'out-of-prefix page never requested');
  assert.ok(state.requests.includes('/docs/hidden'), 'noindex page is fetched but not stored');
  assert.equal(state.requests.filter((u) => u === '/robots.txt').length, 1, 'robots cached per crawl');

  const hits = await app.api('GET', '/api/search?q=flux%20capacitor', { token });
  assert.equal(hits.body.results[0].title, 'Install');
  assert.equal((await app.api('GET', '/api/search?q=draft', { token })).body.total, 0);

  // Deleting the source removes its items from search.
  await app.api('DELETE', `/api/sources/${src.id}`, { token });
  assert.equal((await app.api('GET', '/api/search?q=flux', { token })).body.total, 0);
});

test('site crawl stops at max_pages', async () => {
  const src = await addSource({ name: 'Small docs', url: `${fixture.base}/docs/`.replace('/docs/', '/docs/?v=2'), kind: 'site', max_pages: 2 });
  const { stats } = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body;
  assert.equal(stats.fetched, 2);
});

test('crawl failures are recorded on the source instead of throwing', async () => {
  const src = await addSource({ name: 'Dead feed', url: `${fixture.base}/missing.xml`, kind: 'rss' });
  const { stats } = (await app.api('POST', `/api/sources/${src.id}/crawl`, { token })).body;
  assert.match(stats.errors[0], /HTTP 404/);
  const row = (await app.api('GET', '/api/sources', { token })).body.sources.find((s) => s.id === src.id);
  assert.match(row.last_error, /HTTP 404/);
});

test('crawlDue only crawls sources whose interval elapsed', async () => {
  const results = await app.crawler.crawlDue(new Date());
  assert.deepEqual(results, [], 'everything was crawled moments ago');
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const due = await app.crawler.crawlDue(later);
  assert.ok(due.length >= 3);
});
