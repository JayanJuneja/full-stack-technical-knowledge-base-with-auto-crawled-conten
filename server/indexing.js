/**
 * Glue between database rows and the search index: one place that defines how
 * pages and crawled items are represented as searchable documents.
 */

/** Index id + document for an authored page row. */
export function indexPage(index, page) {
  index.add(`page:${page.id}`, {
    title: page.title,
    body: `${page.body}\n${page.tags ?? ''}`,
    type: 'page',
    meta: { slug: page.slug, tags: page.tags, updatedAt: page.updated_at },
  });
}

/** Index id + document for a crawled item row (joined with its source name). */
export function indexItem(index, item) {
  index.add(`item:${item.id}`, {
    title: item.title,
    body: item.content,
    type: 'item',
    meta: { itemId: item.id, url: item.url, sourceId: item.source_id, sourceName: item.source_name, publishedAt: item.published_at },
  });
}

/** Rebuild the full index from the database (used at startup). */
export async function rebuildIndex(db, index) {
  for (const page of await db.query('SELECT id, slug, title, body, tags, updated_at FROM pages')) indexPage(index, page);
  const items = await db.query(
    `SELECT i.id, i.source_id, i.url, i.title, i.content, i.published_at, s.name AS source_name
     FROM crawled_items i JOIN sources s ON s.id = i.source_id`,
  );
  for (const item of items) indexItem(index, item);
  return index.size;
}
