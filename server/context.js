/** Wires the database, search index, crawler and Express app together. */
import { createDb } from './db.js';
import { SearchIndex } from './search.js';
import { Crawler } from './crawler/crawler.js';
import { rebuildIndex } from './indexing.js';
import { createApp } from './app.js';

/**
 * @param {object} [cfg]
 * @param {string} [cfg.databaseUrl] postgres:// URL, SQLite file path, or ':memory:'
 * @param {object} [cfg.crawler] extra Crawler options (fetchImpl, delayMs, ...)
 * @param {object} [cfg.options] createApp options
 */
export async function createContext({ databaseUrl = ':memory:', crawler: crawlerOpts = {}, options } = {}) {
  const db = await createDb(databaseUrl);
  await db.migrate();
  const index = new SearchIndex();
  await rebuildIndex(db, index);
  const crawler = new Crawler({ db, index, ...crawlerOpts });
  const app = createApp({ db, index, crawler, options });
  return { db, index, crawler, app };
}
