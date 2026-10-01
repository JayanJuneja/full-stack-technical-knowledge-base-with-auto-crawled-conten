/**
 * Seed a fresh database with an admin account, a few wiki pages, and two crawl
 * sources that point at the bundled offline samples (served by the app at /samples).
 *
 *   ADMIN_PASSWORD=... npm run seed
 */
import { mkdirSync } from 'node:fs';
import { createDb } from './db.js';
import { hashPassword } from './auth.js';

const databaseUrl = process.env.DATABASE_URL || 'data/crawlwiki.db';
if (!databaseUrl.startsWith('postgres')) mkdirSync('data', { recursive: true });
const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
const db = await createDb(databaseUrl);
await db.migrate();
const now = new Date().toISOString();

let admin = await db.one("SELECT id FROM users WHERE username = 'admin'");
if (!admin) {
  const password = process.env.ADMIN_PASSWORD || 'change-me-please';
  admin = await db.one(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES ('admin', $1, 'admin', $2) RETURNING id",
    [await hashPassword(password), now],
  );
  console.log(`created user "admin" with password "${password}" (set ADMIN_PASSWORD to choose one)`);
}

const pages = [
  {
    slug: 'onboarding',
    title: 'Engineering onboarding',
    tags: 'onboarding,process',
    body: `# Engineering onboarding\n\nWelcome! Start here.\n\n## First week\n\n- Get access to the **staging** cluster\n- Read [[deploy-runbook]] before your first deploy\n- Run the test suite locally: \`npm test\`\n`,
  },
  {
    slug: 'deploy-runbook',
    title: 'Deploy runbook',
    tags: 'ops,docker',
    body: `# Deploy runbook\n\n1. Merge to \`main\`; CI builds the Docker image.\n2. Watch the rollout dashboard.\n3. Roll back with \`docker compose up -d --no-deps app\` on the previous tag.\n\n\`\`\`bash\ndocker compose pull && docker compose up -d\n\`\`\`\n`,
  },
  {
    slug: 'postgres-conventions',
    title: 'PostgreSQL conventions',
    tags: 'database,postgres',
    body: `# PostgreSQL conventions\n\n- Table names are plural snake_case.\n- Every migration must be reversible.\n- Credentials are rotated quarterly; see the crawled platform notes for the procedure.\n`,
  },
];
for (const p of pages) {
  if (await db.one('SELECT id FROM pages WHERE slug = $1', [p.slug])) continue;
  const row = await db.one(
    `INSERT INTO pages (slug, title, body, tags, version, author_id, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $6) RETURNING id`,
    [p.slug, p.title, p.body, p.tags, admin.id, now],
  );
  await db.query('INSERT INTO page_revisions (page_id, version, title, body, edited_by, created_at) VALUES ($1, 1, $2, $3, $4, $5)', [
    row.id,
    p.title,
    p.body,
    admin.id,
    now,
  ]);
}

const sources = [
  { name: 'Platform notes (sample RSS)', url: `${baseUrl}/samples/feed.xml`, kind: 'rss' },
  { name: 'Acme Queue docs (sample site)', url: `${baseUrl}/samples/docs/index.html`, kind: 'site' },
];
for (const s of sources) {
  if (await db.one('SELECT id FROM sources WHERE url = $1', [s.url])) continue;
  await db.query(
    'INSERT INTO sources (name, url, kind, max_pages, interval_minutes, enabled, created_at) VALUES ($1, $2, $3, 25, 60, 1, $4)',
    [s.name, s.url, s.kind, now],
  );
}
console.log(`seeded ${pages.length} pages and ${sources.length} sources into ${db.dialect}`);
await db.close();
