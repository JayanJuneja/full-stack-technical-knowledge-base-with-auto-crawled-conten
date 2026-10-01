import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchIndex, tokenize, stem, makeSnippet } from '../server/search.js';

test('tokenize lowercases, drops stopwords, stems, and splits compounds', () => {
  assert.deepEqual(tokenize('The Crawlers are Indexing'), ['crawler', 'index']);
  const t = tokenize('Use node.js and max_pages');
  assert.ok(t.includes('node.js') && t.includes('node') && t.includes('js'));
  assert.ok(t.includes('max_pages') && t.includes('max') && t.includes('page'));
  assert.equal(stem('policies'), 'policy');
  assert.equal(stem('class'), 'class');
});

function sampleIndex() {
  const idx = new SearchIndex();
  idx.add('page:1', { title: 'Docker deployment guide', body: 'How we build images and deploy containers.', type: 'page' });
  idx.add('page:2', { title: 'Team lunch', body: 'Docker is mentioned once here among many other words about food and lunch.', type: 'page' });
  idx.add('item:1', { title: 'PostgreSQL tuning', body: 'Vacuum, indexes and connection pooling for postgres.', type: 'item' });
  return idx;
}

test('title matches outrank body-only matches', () => {
  const { results, total } = sampleIndex().search('docker');
  assert.equal(total, 2);
  assert.deepEqual(results.map((r) => r.id), ['page:1', 'page:2']);
  assert.ok(results[0].score > results[1].score);
});

test('multi-term queries reward documents matching more terms', () => {
  const { results } = sampleIndex().search('docker deploy containers');
  assert.equal(results[0].id, 'page:1');
});

test('type filter restricts to pages or crawled items', () => {
  const idx = sampleIndex();
  assert.deepEqual(idx.search('postgres', { type: 'page' }).results, []);
  assert.equal(idx.search('postgres', { type: 'item' }).results[0].id, 'item:1');
});

test('last term is prefix-expanded for type-ahead, but not after a trailing space', () => {
  const idx = sampleIndex();
  assert.equal(idx.search('postgr').results[0]?.id, 'item:1');
  assert.equal(idx.search('postgr ').total, 0);
});

test('re-adding replaces a document and remove() drops it from postings', () => {
  const idx = sampleIndex();
  idx.add('page:2', { title: 'Team lunch', body: 'Only food now.', type: 'page' });
  assert.deepEqual(idx.search('docker').results.map((r) => r.id), ['page:1']);
  idx.remove('page:1');
  assert.equal(idx.search('docker').total, 0);
  assert.equal(idx.size, 2);
  assert.ok(!idx.postings.has('docker'));
});

test('pagination with limit/offset', () => {
  const idx = new SearchIndex();
  for (let i = 0; i < 30; i++) idx.add(`page:${i}`, { title: `Note ${i}`, body: 'kubernetes', type: 'page' });
  const page1 = idx.search('kubernetes', { limit: 10 });
  const page2 = idx.search('kubernetes', { limit: 10, offset: 10 });
  assert.equal(page1.total, 30);
  assert.equal(page2.results.length, 10);
  assert.ok(!page2.results.some((r) => page1.results.find((p) => p.id === r.id)));
});

test('makeSnippet centres on the first match', () => {
  const body = 'x '.repeat(300) + 'the robots.txt file matters ' + 'y '.repeat(300);
  const snip = makeSnippet(body, 'robots');
  assert.ok(snip.includes('robots.txt'));
  assert.ok(snip.startsWith('…') && snip.endsWith('…'));
  assert.ok(snip.length < 210);
});
