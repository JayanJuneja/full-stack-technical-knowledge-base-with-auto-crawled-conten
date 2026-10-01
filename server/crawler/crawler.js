/**
 * Background crawler that ingests external RSS/Atom feeds and documentation sites
 * into `crawled_items`, keeping the shared search index in sync.
 *
 * Politeness & efficiency features:
 *   - robots.txt is fetched once per origin per crawl and honoured
 *   - `<meta name="robots" content="noindex|nofollow">` is honoured
 *   - feeds use conditional GET (ETag / Last-Modified -> 304 Not Modified)
 *   - unchanged content is detected by SHA-256 and not rewritten
 *   - per-request timeout, response size cap, optional delay between requests
 *   - site crawls are BFS, same-origin, restricted to the start URL's path prefix
 */
import { createHash } from 'node:crypto';
import { parseFeed, extractHtml } from './parse.js';
import { parseRobots } from './robots.js';
import { indexItem } from '../indexing.js';

const MAX_CONTENT_CHARS = 100_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Crawler {
  /**
   * @param {object} opts
   * @param {import('../db.js').Db} opts.db
   * @param {import('../search.js').SearchIndex} opts.index
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {string} [opts.userAgent]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxBytes]
   * @param {number} [opts.delayMs] pause between requests to the same site
   */
  constructor({ db, index, fetchImpl = fetch, userAgent = 'CrawlWikiBot/1.0', timeoutMs = 10_000, maxBytes = 2_000_000, delayMs = 0 }) {
    Object.assign(this, { db, index, fetchImpl, userAgent, timeoutMs, maxBytes, delayMs });
    this.running = new Set();
  }

  async #get(url, headers = {}) {
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': this.userAgent, ...headers },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow',
    });
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > this.maxBytes) throw new Error(`response too large (${declared} bytes)`);
    const body = res.status === 304 ? '' : await res.text();
    if (body.length > this.maxBytes) throw new Error(`response too large (${body.length} bytes)`);
    return { status: res.status, headers: res.headers, body, url: res.url || url };
  }

  /** Returns a cached `allowed(url)` predicate for the URL's origin. */
  async #robotsFor(url, cache) {
    const origin = new URL(url).origin;
    if (!cache.has(origin)) {
      let allowed = () => true;
      try {
        const r = await this.#get(`${origin}/robots.txt`);
        if (r.status === 200) allowed = parseRobots(r.body, this.userAgent.split('/')[0]);
      } catch {
        /* unreachable robots.txt => allow, per common practice */
      }
      cache.set(origin, allowed);
    }
    const u = new URL(url);
    return cache.get(origin)(u.pathname + u.search);
  }

  /** Insert or update one crawled document; returns 'added' | 'updated' | 'unchanged'. */
  async upsertItem(source, { url, title, content, publishedAt }) {
    content = content.slice(0, MAX_CONTENT_CHARS);
    const hash = createHash('sha256').update(`${title}\n${content}`).digest('hex');
    const now = new Date().toISOString();
    const existing = await this.db.one('SELECT id, content_hash FROM crawled_items WHERE url = $1', [url]);
    if (existing && existing.content_hash === hash) return 'unchanged';
    let row;
    if (existing) {
      row = await this.db.one(
        `UPDATE crawled_items SET title = $1, content = $2, content_hash = $3, published_at = $4, fetched_at = $5, source_id = $6
         WHERE id = $7 RETURNING *`,
        [title, content, hash, publishedAt ?? null, now, source.id, existing.id],
      );
    } else {
      row = await this.db.one(
        `INSERT INTO crawled_items (source_id, url, title, content, content_hash, published_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [source.id, url, title, content, hash, publishedAt ?? null, now],
      );
    }
    indexItem(this.index, { ...row, source_name: source.name });
    return existing ? 'updated' : 'added';
  }

  async #crawlFeed(source, stats, robots) {
    if (!(await this.#robotsFor(source.url, robots))) {
      stats.skipped++;
      return;
    }
    const headers = {};
    if (source.etag) headers['if-none-match'] = source.etag;
    if (source.last_modified) headers['if-modified-since'] = source.last_modified;
    const res = await this.#get(source.url, headers);
    stats.fetched++;
    if (res.status === 304) {
      stats.notModified = true;
      return;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${source.url}`);
    const feed = parseFeed(res.body, res.url);
    for (const item of feed.items) stats[await this.upsertItem(source, item)]++;
    await this.db.query('UPDATE sources SET etag = $1, last_modified = $2 WHERE id = $3', [
      res.headers.get('etag'),
      res.headers.get('last-modified'),
      source.id,
    ]);
  }

  async #crawlSite(source, stats, robots) {
    const start = new URL(source.url);
    start.hash = '';
    const prefix = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
    const inScope = (u) => u.origin === start.origin && u.pathname.startsWith(prefix);
    const seen = new Set([start.href]);
    const queue = [start.href];

    while (queue.length && stats.fetched < source.max_pages) {
      const url = queue.shift();
      if (!(await this.#robotsFor(url, robots))) {
        stats.skipped++;
        continue;
      }
      if (stats.fetched > 0 && this.delayMs) await sleep(this.delayMs);
      let res;
      try {
        res = await this.#get(url);
      } catch (err) {
        stats.errors.push(`${url}: ${err.message}`);
        continue;
      }
      stats.fetched++;
      const type = res.headers.get('content-type') || '';
      if (res.status !== 200 || !type.includes('html')) {
        if (res.status !== 200) stats.errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const page = extractHtml(res.body, res.url);
      if (!page.noindex && page.text) stats[await this.upsertItem(source, { url, title: page.title, content: page.text })]++;
      if (page.nofollow) continue;
      for (const link of page.links) {
        const u = new URL(link);
        if (inScope(u) && !seen.has(u.href)) {
          seen.add(u.href);
          queue.push(u.href);
        }
      }
    }
  }

  /**
   * Crawl one source row now. Never throws: failures are recorded on the source.
   * @returns {Promise<{fetched: number, added: number, updated: number, unchanged: number, skipped: number, notModified: boolean, errors: string[]}>}
   */
  async crawlSource(source) {
    const stats = { fetched: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, notModified: false, errors: [] };
    if (this.running.has(source.id)) {
      stats.errors.push('crawl already in progress');
      return stats;
    }
    this.running.add(source.id);
    const robots = new Map();
    try {
      if (source.kind === 'rss') await this.#crawlFeed(source, stats, robots);
      else await this.#crawlSite(source, stats, robots);
    } catch (err) {
      stats.errors.push(err.message);
    } finally {
      this.running.delete(source.id);
    }
    const status = stats.notModified
      ? 'not modified'
      : `${stats.added} added, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.skipped} blocked by robots`;
    await this.db.query('UPDATE sources SET last_crawled_at = $1, last_status = $2, last_error = $3 WHERE id = $4', [
      new Date().toISOString(),
      status,
      stats.errors.length ? stats.errors.slice(0, 5).join('; ') : null,
      source.id,
    ]);
    return stats;
  }

  /** Crawl every enabled source whose interval has elapsed. */
  async crawlDue(now = new Date()) {
    const sources = await this.db.query('SELECT * FROM sources WHERE enabled = 1 ORDER BY id');
    const due = sources.filter(
      (s) => !s.last_crawled_at || new Date(s.last_crawled_at).getTime() + s.interval_minutes * 60_000 <= now.getTime(),
    );
    const results = [];
    for (const s of due) results.push({ sourceId: s.id, ...(await this.crawlSource(s)) });
    return results;
  }

  /** Start a periodic scheduler; returns a function that stops it. */
  start(everyMs = 60_000) {
    const tick = () => this.crawlDue().catch((err) => console.error('[crawler]', err));
    const timer = setInterval(tick, everyMs);
    timer.unref();
    tick();
    return () => clearInterval(timer);
  }
}
