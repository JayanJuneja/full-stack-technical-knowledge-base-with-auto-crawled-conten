-- Portable schema: runs unchanged on PostgreSQL and SQLite.
-- `{{ID}}` is replaced by the adapter with the dialect's auto-increment primary key.
-- Timestamps are ISO-8601 strings written by the application.

CREATE TABLE IF NOT EXISTS users (
  id            {{ID}},
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id         {{ID}},
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_revisions (
  id         {{ID}},
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  edited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, version)
);

CREATE TABLE IF NOT EXISTS sources (
  id               {{ID}},
  name             TEXT NOT NULL,
  url              TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('rss', 'site')),
  max_pages        INTEGER NOT NULL DEFAULT 25,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  enabled          INTEGER NOT NULL DEFAULT 1,
  etag             TEXT,
  last_modified    TEXT,
  last_crawled_at  TEXT,
  last_status      TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawled_items (
  id           {{ID}},
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  published_at TEXT,
  fetched_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_source ON crawled_items(source_id);
CREATE INDEX IF NOT EXISTS idx_revisions_page ON page_revisions(page_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
