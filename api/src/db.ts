import SQLite from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

export type { Database };

/**
 * The full schema. Applied idempotently on every boot — the app owns exactly
 * one table, so a migration framework would be more machinery than the problem
 * warrants. The CHECK constraints are the last line of defence behind request
 * validation: invalid stock cannot be persisted even by a caller that bypasses
 * the HTTP layer.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id         TEXT    PRIMARY KEY,
  sku        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL CHECK (length(name) > 0),
  quantity   INTEGER NOT NULL CHECK (quantity >= 0),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at DESC, id DESC);

-- One photo per item, replaced on re-upload. Stored as a BLOB rather than a
-- file on disk: the image lives and dies with its row (ON DELETE CASCADE), so
-- there are no orphaned files to reap and no filename to sanitise.
CREATE TABLE IF NOT EXISTS item_photos (
  item_id      TEXT    PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  content_type TEXT    NOT NULL,
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),
  bytes        BLOB    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
`;

export function openDatabase(path: string): Database {
  const db = new SQLite(path);

  // WAL keeps readers from blocking the writer; FULL synchronous is overkill
  // for an inventory list but NORMAL still survives process crashes.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);

  return db;
}
