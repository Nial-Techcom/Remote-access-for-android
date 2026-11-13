import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/db.js';

describe('migrations', () => {
  it('cree le schema et reste idempotent a la reouverture', () => {
    const d = mkdtempSync(join(tmpdir(), 'nial-db-'));
    openDb(d).close();
    const db = openDb(d);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION());
    db.close();
  });
  it('refuse de demarrer sur une base plus recente que le serveur', () => {
    const d = mkdtempSync(join(tmpdir(), 'nial-db-'));
    openDb(d).close();
    const raw = new DatabaseSync(join(d, 'nial.db'));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION() + 1}`);
    raw.close();
    expect(() => openDb(d)).toThrow(/plus recente/);
  });
});
