import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1 : socle
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    reset_hash TEXT,
    reset_exp INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_hash TEXT NOT NULL UNIQUE,
    access_exp INTEGER NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    prev_refresh_hash TEXT,
    refresh_exp INTEGER NOT NULL,
    abs_exp INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    revoked_at INTEGER,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    model TEXT,
    os TEXT,
    public_key TEXT NOT NULL,
    caps TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
    next_seq INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    caps TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    device_id TEXT
  );
  CREATE TABLE device_grants (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    perms TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id TEXT,
    type TEXT NOT NULL,
    envelope TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    exp INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    delivered_at INTEGER,
    ack_at INTEGER,
    error TEXT
  );
  CREATE INDEX commands_device ON commands(device_id, status);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    details TEXT
  );
  CREATE INDEX audit_ts ON audit(ts);
  CREATE INDEX audit_target ON audit(target);
  CREATE TABLE song_hashes (
    song_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (song_id, size)
  );
  `,
];

export function openDb(dataDir: string): Db {
  const path = dataDir === ':memory:' ? ':memory:' : (mkdirSync(dataDir, { recursive: true, mode: 0o700 }), join(dataDir, 'nial.db'));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const nowMs = (): number => Date.now();
