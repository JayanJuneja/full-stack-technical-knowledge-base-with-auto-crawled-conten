/** Shared test utilities: boot the real app on an ephemeral port. */
import { createContext } from '../server/context.js';

/**
 * Start a fresh app instance. Uses in-memory SQLite by default; set
 * TEST_DATABASE_URL=postgres://... to run the same suite against PostgreSQL (CI does).
 */
export async function startApp({ crawler, options } = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL || ':memory:';
  const ctx = await createContext({ databaseUrl, crawler, options });
  if (databaseUrl !== ':memory:') {
    await ctx.db.truncateAll();
    for (const id of [...ctx.index.docs.keys()]) ctx.index.remove(id);
  }
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** JSON request helper returning { status, body }. */
  async function api(method, path, { body, token } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await ctx.db.close();
  }

  return { ...ctx, base, api, close };
}

/** Start a throwaway HTTP server from a `(req, res) => void` handler. */
export async function startFixtureServer(handler) {
  const { createServer } = await import('node:http');
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
