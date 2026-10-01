/**
 * Authentication: scrypt password hashing and opaque bearer session tokens.
 * Only a SHA-256 hash of each token is stored, so a leaked DB cannot be replayed.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hash a password as `scrypt$<salt>$<key>` (hex). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time check of a password against a stored hash. */
export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Create a session for a user and return the raw token (shown to the client once). */
export async function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    expires,
  ]);
  return token;
}

/** Resolve a raw token to its user, or null if missing/expired. */
export async function userForToken(db, token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT u.id, u.username, u.role, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export async function deleteSession(db, token) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Express middleware: attaches `req.user` from the `Authorization: Bearer` header. */
export function authenticate(db) {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization') || '';
      req.token = header.startsWith('Bearer ') ? header.slice(7) : null;
      req.user = await userForToken(db, req.token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Express middleware factory: require a logged-in user, optionally with a given role. */
export function requireUser(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (role && req.user.role !== role) return res.status(403).json({ error: `${role} role required` });
    next();
  };
}
