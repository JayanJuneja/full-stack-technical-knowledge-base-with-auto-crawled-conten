/**
 * Tiny database adapter with one async API over two drivers:
 *   - PostgreSQL (via `pg`) when a postgres:// URL is given (production / Docker / CI)
 *   - SQLite (via Node's built-in `node:sqlite`) otherwise (local dev, tests, benchmark)
 *
 * All SQL in the app is written with Postgres-style `$1` placeholders; the SQLite
 * driver rewrites them to the equivalent numbered `?1` form.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
const TABLES = ['crawled_items', 'sources', 'page_revisions', 'pages', 'sessions', 'users'];

/**
 * @typedef {object} Db
 * @property {'postgres'|'sqlite'} dialect
 * @property {(sql: string, params?: unknown[]) => Promise<any[]>} query  Run SQL, return rows.
 * @property {(sql: string, params?: unknown[]) => Promise<any|undefined>} one  First row or undefined.
 * @property {() => Promise<void>} migrate  Create tables if missing.
 * @property {() => Promise<void>} truncateAll  Delete all rows (tests only).
 * @property {() => Promise<void>} close
 */

/**
 * @param {string} [url] postgres://... for Postgres; a file path or ':memory:' for SQLite.
 * @returns {Promise<Db>}
 */
export async function createDb(url = ':memory:') {
  const db = /^postgres(ql)?:\/\//.test(url) ? await createPostgres(url) : await createSqlite(url);
  db.one = async (sql, params) => (await db.query(sql, params))[0];
  db.migrate = async () => {
    const id = db.dialect === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const statements = readFileSync(SCHEMA_PATH, 'utf8')
      .replace(/--.*$/gm, '')
      .replaceAll('{{ID}}', id)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await db.query(stmt);
  };
  db.truncateAll = async () => {
    for (const t of TABLES) await db.query(`DELETE FROM ${t}`);
  };
  return db;
}

async function createPostgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    dialect: 'postgres',
    async query(sql, params = []) {
      return (await pool.query(sql, params)).rows;
    },
    close: () => pool.end(),
  };
}

async function createSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const cache = new Map();
  return {
    dialect: 'sqlite',
    async query(sql, params = []) {
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = conn.prepare(sql.replace(/\$(\d+)/g, '?$1'));
        cache.set(sql, stmt);
      }
      return stmt.all(...params.map((p) => (p === undefined ? null : p)));
    },
    async close() {
      conn.close();
    },
  };
}
