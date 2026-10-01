/**
 * Production entry point.
 *
 * Environment:
 *   DATABASE_URL        postgres://... (Docker) or a SQLite file path (default: data/crawlwiki.db)
 *   PORT                HTTP port (default 3000)
 *   ALLOW_REGISTRATION  "false" to restrict sign-up to admins after the first user
 *   CRAWL_EVERY_SECONDS scheduler tick; 0 disables background crawling (default 60)
 *   CRAWL_DELAY_MS      politeness delay between requests to a site (default 500)
 */
import { mkdirSync } from 'node:fs';
import { createContext } from './context.js';

const databaseUrl = process.env.DATABASE_URL || 'data/crawlwiki.db';
if (!databaseUrl.startsWith('postgres')) mkdirSync('data', { recursive: true });

const { app, crawler, index, db } = await createContext({
  databaseUrl,
  crawler: { delayMs: Number(process.env.CRAWL_DELAY_MS ?? 500) },
  options: { allowRegistration: process.env.ALLOW_REGISTRATION !== 'false' },
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`CrawlWiki listening on http://localhost:${port} (${db.dialect}, ${index.size} docs indexed)`);
});

const every = Number(process.env.CRAWL_EVERY_SECONDS ?? 60);
const stopCrawler = every > 0 ? crawler.start(every * 1000) : () => {};

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopCrawler();
    server.close(() => db.close().then(() => process.exit(0)));
  });
}
