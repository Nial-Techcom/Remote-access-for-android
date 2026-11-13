import type { Db } from './db.js';
import { nowMs } from './db.js';

export type ActorType = 'user' | 'device' | 'system';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

const FORBIDDEN = /pass|secret|token|key|sig/i;

/** Les details ne doivent jamais contenir de secret : on retire toute cle suspecte par precaution. */
function scrub(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) if (!FORBIDDEN.test(k)) clean[k] = v;
  return JSON.stringify(clean);
}

export class Audit {
  constructor(private readonly db: Db) {}

  log(e: AuditEntry): void {
    try {
      this.db
        .prepare('INSERT INTO audit (ts, actor_type, actor_id, action, target, ip, details) VALUES (?,?,?,?,?,?,?)')
        .run(nowMs(), e.actorType, e.actorId ?? null, e.action, e.target ?? null, e.ip ?? null, scrub(e.details));
    } catch (err) {
      // Une ecriture d'audit ne doit jamais faire tomber le serveur (ex. base deja fermee a l'arret).
      console.error('audit: ecriture impossible', e.action, err instanceof Error ? err.message : err);
    }
  }

  list(opts: { limit: number; before?: number; target?: string }): unknown[] {
    const limit = Math.min(Math.max(opts.limit, 1), 500);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.before) { where.push('id < ?'); args.push(opts.before); }
    if (opts.target) { where.push('target = ?'); args.push(opts.target); }
    const sql = `SELECT id, ts, actor_type AS actorType, actor_id AS actorId, action, target, ip, details FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...args);
  }
}
