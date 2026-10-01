/**
 * Express application: JSON API for auth, wiki pages (with revisions and optimistic
 * locking), crawl sources, crawled items and unified search. Also serves the built
 * React app from `web/dist` when present.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, createSession, deleteSession, authenticate, requireUser } from './auth.js';
import { indexPage } from './indexing.js';

const WEB_DIST = fileURLToPath(new URL('../web/dist', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../samples', import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Convert a title to a URL slug: "Hello, World!" -> "hello-world". */
export function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'page'
  );
}

function str(value, field, { min = 1, max = 200_000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new HttpError(400, `${field} must be a string of ${min}-${max} characters`);
  }
  return value.trim();
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20).join(',');
}

/** Parse a positive integer route param, or 404 (avoids passing NaN to Postgres). */
function intParam(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'not found');
  return n;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {import('./db.js').Db} deps.db
 * @param {import('./search.js').SearchIndex} deps.index
 * @param {import('./crawler/crawler.js').Crawler} deps.crawler
 * @param {{allowRegistration?: boolean, serveSamples?: boolean}} [deps.options]
 */
export function createApp({ db, index, crawler, options = {} }) {
  const { allowRegistration = true, serveSamples = true } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', authenticate(db));

  app.get('/api/health', (_req, res) => res.json({ ok: true, indexed: index.size, dialect: db.dialect }));

  // ---------- auth ----------
  app.post(
    '/api/auth/register',
    wrap(async (req, res) => {
      const username = str(req.body.username, 'username', { min: 3, max: 40 });
      const password = str(req.body.password, 'password', { min: 8, max: 200 });
      if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new HttpError(400, 'username may only contain letters, digits, _ . -');
      const { n } = await db.one('SELECT COUNT(*) AS n FROM users');
      const first = Number(n) === 0;
      if (!first && !allowRegistration && req.user?.role !== 'admin') throw new HttpError(403, 'registration is closed');
      if (await db.one('SELECT id FROM users WHERE username = $1', [username])) throw new HttpError(409, 'username taken');
      // The very first account bootstraps the instance as admin.
      const role = first ? 'admin' : 'editor';
      const user = await db.one(
        'INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
        [username, await hashPassword(password), role, new Date().toISOString()],
      );
      res.status(201).json({ user: { ...user }, token: await createSession(db, user.id) });
    }),
  );

  app.post(
    '/api/auth/login',
    wrap(async (req, res) => {
      const row = await db.one('SELECT id, username, role, password_hash FROM users WHERE username = $1', [String(req.body.username ?? '')]);
      if (!row || !(await verifyPassword(String(req.body.password ?? ''), row.password_hash))) {
        throw new HttpError(401, 'invalid username or password');
      }
      res.json({ user: { id: row.id, username: row.username, role: row.role }, token: await createSession(db, row.id) });
    }),
  );

  app.post(
    '/api/auth/logout',
    requireUser(),
    wrap(async (req, res) => {
      await deleteSession(db, req.token);
      res.status(204).end();
    }),
  );

  app.get('/api/auth/me', requireUser(), (req, res) => res.json({ user: req.user }));

  // Everything below requires a logged-in user.
  app.use('/api', requireUser());

  // ---------- pages ----------
  const PAGE_COLS = `p.id, p.slug, p.title, p.body, p.tags, p.version, p.created_at, p.updated_at,
    a.username AS author, e.username AS updated_by`;
  const PAGE_FROM = 'pages p LEFT JOIN users a ON a.id = p.author_id LEFT JOIN users e ON e.id = p.updated_by';
  const getPage = (slug) => db.one(`SELECT ${PAGE_COLS} FROM ${PAGE_FROM} WHERE p.slug = $1`, [slug]);

  app.get(
    '/api/pages',
    wrap(async (req, res) => {
      const tag = req.query.tag ? String(req.query.tag).toLowerCase() : null;
      let rows = await db.query(
        `SELECT p.id, p.slug, p.title, p.tags, p.version, p.updated_at, e.username AS updated_by
         FROM pages p LEFT JOIN users e ON e.id = p.updated_by ORDER BY p.updated_at DESC`,
      );
      if (tag) rows = rows.filter((r) => r.tags.split(',').includes(tag));
      res.json({ pages: rows });
    }),
  );

  app.get(
    '/api/pages/:slug',
    wrap(async (req, res) => {
      const page = await getPage(req.params.slug);
      if (!page) throw new HttpError(404, 'page not found');
      res.json({ page });
    }),
  );

  app.post(
    '/api/pages',
    wrap(async (req, res) => {
      const title = str(req.body.title, 'title', { max: 200 });
      const body = str(req.body.body ?? '', 'body', { min: 0 });
      const tags = normalizeTags(req.body.tags);
      const base = slugify(req.body.slug || title);
      let slug = base;
      for (let i = 2; await db.one('SELECT id FROM pages WHERE slug = $1', [slug]); i++) slug = `${base}-${i}`;
      const now = new Date().toISOString();
      const page = await db.one(
        `INSERT INTO pages (slug, title, body, tags, version, author_id, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $6) RETURNING *`,
        [slug, title, body, tags, req.user.id, now],
      );
      await db.query('INSERT INTO page_revisions (page_id, version, title, body, edited_by, created_at) VALUES ($1, 1, $2, $3, $4, $5)', [
        page.id,
        title,
        body,
        req.user.id,
        now,
      ]);
      indexPage(index, page);
      res.status(201).json({ page: await getPage(slug) });
    }),
  );

  app.put(
    '/api/pages/:slug',
    wrap(async (req, res) => {
      const current = await db.one('SELECT * FROM pages WHERE slug = $1', [req.params.slug]);
      if (!current) throw new HttpError(404, 'page not found');
      const baseVersion = Number(req.body.version);
      if (!Number.isInteger(baseVersion)) throw new HttpError(400, 'version (the version you edited) is required');
      const title = req.body.title === undefined ? current.title : str(req.body.title, 'title', { max: 200 });
      const body = req.body.body === undefined ? current.body : str(req.body.body, 'body', { min: 0 });
      const tags = req.body.tags === undefined ? current.tags : normalizeTags(req.body.tags);
      const now = new Date().toISOString();
      // Optimistic locking: the UPDATE only matches if nobody saved in between.
      const page = await db.one(
        `UPDATE pages SET title = $1, body = $2, tags = $3, version = version + 1, updated_by = $4, updated_at = $5
         WHERE id = $6 AND version = $7 RETURNING *`,
        [title, body, tags, req.user.id, now, current.id, baseVersion],
      );
      if (!page) {
        return res.status(409).json({ error: 'page was modified by someone else', current: await getPage(current.slug) });
      }
      await db.query('INSERT INTO page_revisions (page_id, version, title, body, edited_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        page.id,
        page.version,
        title,
        body,
        req.user.id,
        now,
      ]);
      indexPage(index, page);
      res.json({ page: await getPage(page.slug) });
    }),
  );

  app.delete(
    '/api/pages/:slug',
    requireUser('admin'),
    wrap(async (req, res) => {
      const page = await db.one('DELETE FROM pages WHERE slug = $1 RETURNING id', [req.params.slug]);
      if (!page) throw new HttpError(404, 'page not found');
      index.remove(`page:${page.id}`);
      res.status(204).end();
    }),
  );

  app.get(
    '/api/pages/:slug/revisions',
    wrap(async (req, res) => {
      const page = await db.one('SELECT id FROM pages WHERE slug = $1', [req.params.slug]);
      if (!page) throw new HttpError(404, 'page not found');
      const revisions = await db.query(
        `SELECT r.version, r.title, r.body, r.created_at, u.username AS edited_by
         FROM page_revisions r LEFT JOIN users u ON u.id = r.edited_by WHERE r.page_id = $1 ORDER BY r.version DESC`,
        [page.id],
      );
      res.json({ revisions });
    }),
  );

  // ---------- search ----------
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q ?? '');
    const type = ['page', 'item'].includes(req.query.type) ? req.query.type : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ query: q, ...index.search(q, { type, limit, offset }) });
  });

  // ---------- crawled items ----------
  app.get(
    '/api/items/:id',
    wrap(async (req, res) => {
      const item = await db.one(
        `SELECT i.*, s.name AS source_name FROM crawled_items i JOIN sources s ON s.id = i.source_id WHERE i.id = $1`,
        [intParam(req.params.id)],
      );
      if (!item) throw new HttpError(404, 'item not found');
      res.json({ item });
    }),
  );

  // ---------- sources (crawler config) ----------
  app.get(
    '/api/sources',
    wrap(async (_req, res) => {
      const sources = await db.query(
        `SELECT s.id, s.name, s.url, s.kind, s.max_pages, s.interval_minutes, s.enabled, s.last_crawled_at, s.last_status, s.last_error,
           (SELECT COUNT(*) FROM crawled_items i WHERE i.source_id = s.id) AS item_count
         FROM sources s ORDER BY s.id`,
      );
      res.json({ sources: sources.map((s) => ({ ...s, item_count: Number(s.item_count), enabled: Boolean(s.enabled) })) });
    }),
  );

  app.post(
    '/api/sources',
    requireUser('admin'),
    wrap(async (req, res) => {
      const name = str(req.body.name, 'name', { max: 100 });
      const url = str(req.body.url, 'url', { max: 2000 });
      if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) throw new HttpError(400, 'url must be an http(s) URL');
      const kind = req.body.kind === 'site' ? 'site' : 'rss';
      const maxPages = Math.min(Math.max(Number(req.body.max_pages) || 25, 1), 500);
      const interval = Math.min(Math.max(Number(req.body.interval_minutes) || 60, 5), 7 * 24 * 60);
      if (await db.one('SELECT id FROM sources WHERE url = $1', [url])) throw new HttpError(409, 'source already exists');
      const source = await db.one(
        `INSERT INTO sources (name, url, kind, max_pages, interval_minutes, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING *`,
        [name, url, kind, maxPages, interval, new Date().toISOString()],
      );
      res.status(201).json({ source: { ...source } });
    }),
  );

  app.delete(
    '/api/sources/:id',
    requireUser('admin'),
    wrap(async (req, res) => {
      const id = intParam(req.params.id);
      const items = await db.query('SELECT id FROM crawled_items WHERE source_id = $1', [id]);
      // Explicit child delete keeps behaviour identical whether or not FK cascades are enforced.
      await db.query('DELETE FROM crawled_items WHERE source_id = $1', [id]);
      const gone = await db.one('DELETE FROM sources WHERE id = $1 RETURNING id', [id]);
      if (!gone) throw new HttpError(404, 'source not found');
      for (const it of items) index.remove(`item:${it.id}`);
      res.status(204).end();
    }),
  );

  app.post(
    '/api/sources/:id/crawl',
    requireUser('admin'),
    wrap(async (req, res) => {
      const source = await db.one('SELECT * FROM sources WHERE id = $1', [intParam(req.params.id)]);
      if (!source) throw new HttpError(404, 'source not found');
      res.json({ stats: await crawler.crawlSource(source) });
    }),
  );

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // ---------- static ----------
  if (serveSamples) app.use('/samples', express.static(SAMPLES));
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (_req, res) => res.sendFile(`${WEB_DIST}/index.html`));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
