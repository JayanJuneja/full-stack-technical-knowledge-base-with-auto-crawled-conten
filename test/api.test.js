import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
let adminToken;
let editorToken;

before(async () => {
  app = await startApp();
  const admin = await app.api('POST', '/api/auth/register', { body: { username: 'alice', password: 'correct-horse' } });
  assert.equal(admin.status, 201);
  assert.equal(admin.body.user.role, 'admin', 'first user bootstraps as admin');
  adminToken = admin.body.token;
  const editor = await app.api('POST', '/api/auth/register', { body: { username: 'bob', password: 'battery-staple' } });
  assert.equal(editor.body.user.role, 'editor');
  editorToken = editor.body.token;
});

after(() => app.close());

test('registration validates input and rejects duplicates', async () => {
  assert.equal((await app.api('POST', '/api/auth/register', { body: { username: 'al', password: 'longenough' } })).status, 400);
  assert.equal((await app.api('POST', '/api/auth/register', { body: { username: 'carol', password: 'short' } })).status, 400);
  assert.equal((await app.api('POST', '/api/auth/register', { body: { username: 'alice', password: 'whatever123' } })).status, 409);
});

test('login, me, logout lifecycle', async () => {
  assert.equal((await app.api('POST', '/api/auth/login', { body: { username: 'bob', password: 'wrong-pass' } })).status, 401);
  const login = await app.api('POST', '/api/auth/login', { body: { username: 'bob', password: 'battery-staple' } });
  assert.equal(login.status, 200);
  const me = await app.api('GET', '/api/auth/me', { token: login.body.token });
  assert.equal(me.body.user.username, 'bob');
  assert.equal((await app.api('POST', '/api/auth/logout', { token: login.body.token })).status, 204);
  assert.equal((await app.api('GET', '/api/auth/me', { token: login.body.token })).status, 401);
});

test('API requires authentication', async () => {
  assert.equal((await app.api('GET', '/api/pages')).status, 401);
  assert.equal((await app.api('GET', '/api/search?q=x')).status, 401);
  assert.equal((await app.api('GET', '/api/pages', { token: 'bogus' })).status, 401);
});

test('page CRUD with revisions, optimistic locking and search sync', async () => {
  const created = await app.api('POST', '/api/pages', {
    token: editorToken,
    body: { title: 'Kafka Consumer Guide', body: 'Consumer groups rebalance on join.', tags: 'Streaming, kafka' },
  });
  assert.equal(created.status, 201);
  const { page } = created.body;
  assert.equal(page.slug, 'kafka-consumer-guide');
  assert.equal(page.tags, 'streaming,kafka');
  assert.equal(page.version, 1);
  assert.equal(page.author, 'bob');

  // Duplicate titles get unique slugs.
  const dup = await app.api('POST', '/api/pages', { token: editorToken, body: { title: 'Kafka Consumer Guide', body: '' } });
  assert.equal(dup.body.page.slug, 'kafka-consumer-guide-2');

  let hits = await app.api('GET', '/api/search?q=rebalance', { token: editorToken });
  assert.equal(hits.body.results[0].meta.slug, 'kafka-consumer-guide');

  const updated = await app.api('PUT', `/api/pages/${page.slug}`, {
    token: adminToken,
    body: { version: 1, body: 'Consumers commit offsets after processing.' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.page.version, 2);
  assert.equal(updated.body.page.updated_by, 'alice');

  // A stale editor (still on version 1) gets a conflict with the current page.
  const stale = await app.api('PUT', `/api/pages/${page.slug}`, { token: editorToken, body: { version: 1, body: 'overwrite!' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.version, 2);

  hits = await app.api('GET', '/api/search?q=rebalance', { token: editorToken });
  assert.equal(hits.body.total, 0, 'old body no longer searchable');
  hits = await app.api('GET', '/api/search?q=offsets', { token: editorToken });
  assert.equal(hits.body.total, 1);

  const revs = await app.api('GET', `/api/pages/${page.slug}/revisions`, { token: editorToken });
  assert.deepEqual(revs.body.revisions.map((r) => [r.version, r.edited_by]), [[2, 'alice'], [1, 'bob']]);

  const byTag = await app.api('GET', '/api/pages?tag=kafka', { token: editorToken });
  assert.deepEqual(byTag.body.pages.map((p) => p.slug), ['kafka-consumer-guide']);

  // Only admins may delete.
  assert.equal((await app.api('DELETE', `/api/pages/${page.slug}`, { token: editorToken })).status, 403);
  assert.equal((await app.api('DELETE', `/api/pages/${page.slug}`, { token: adminToken })).status, 204);
  assert.equal((await app.api('GET', `/api/pages/${page.slug}`, { token: adminToken })).status, 404);
  hits = await app.api('GET', '/api/search?q=offsets', { token: editorToken });
  assert.equal(hits.body.total, 0);
});

test('page validation errors', async () => {
  assert.equal((await app.api('POST', '/api/pages', { token: editorToken, body: { title: '' } })).status, 400);
  assert.equal((await app.api('PUT', '/api/pages/nope', { token: editorToken, body: { version: 1 } })).status, 404);
  assert.equal((await app.api('GET', '/api/items/not-a-number', { token: editorToken })).status, 404);
  assert.equal((await app.api('GET', '/api/items/999', { token: editorToken })).status, 404);
  assert.equal((await app.api('GET', '/api/nope', { token: editorToken })).status, 404);
  const p = await app.api('POST', '/api/pages', { token: editorToken, body: { title: 'Needs version' } });
  assert.equal((await app.api('PUT', `/api/pages/${p.body.page.slug}`, { token: editorToken, body: { title: 'x' } })).status, 400);
});

test('sources are admin-managed and validated', async () => {
  const body = { name: 'Blog', url: 'https://example.com/feed.xml', kind: 'rss' };
  assert.equal((await app.api('POST', '/api/sources', { token: editorToken, body })).status, 403);
  assert.equal((await app.api('POST', '/api/sources', { token: adminToken, body: { ...body, url: 'ftp://x' } })).status, 400);
  const created = await app.api('POST', '/api/sources', { token: adminToken, body });
  assert.equal(created.status, 201);
  assert.equal((await app.api('POST', '/api/sources', { token: adminToken, body })).status, 409);
  const list = await app.api('GET', '/api/sources', { token: editorToken });
  assert.equal(list.body.sources[0].item_count, 0);
  assert.equal(list.body.sources[0].enabled, true);
  assert.equal((await app.api('DELETE', `/api/sources/${created.body.source.id}`, { token: adminToken })).status, 204);
});
