import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { nowMs } from './db.js';
import { hashToken, isValidDevicePublicKey, newPairingCode, newToken, sha256Hex, type ServerKeys } from './crypto.js';
import { HttpError, type AuthUser } from './auth.js';
import {
  COMMANDS,
  DEFAULT_CAPS,
  PERMISSIONS,
  PROTOCOL_VERSION,
  envelopeSigningString,
  type CommandEnvelope,
  type CommandType,
  type Permission,
} from './protocol.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface DeviceRow {
  id: string;
  owner_id: string;
  name: string;
  model: string | null;
  os: string | null;
  public_key: string;
  caps: string;
  status: 'pending' | 'active' | 'revoked';
  next_seq: number;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface DeviceView {
  id: string;
  name: string;
  model: string | null;
  os: string | null;
  status: string;
  caps: Permission[];
  createdAt: number;
  lastSeenAt: number | null;
  ownerId: string;
}

const view = (d: DeviceRow): DeviceView => ({
  id: d.id,
  name: d.name,
  model: d.model,
  os: d.os,
  status: d.status,
  caps: JSON.parse(d.caps) as Permission[],
  createdAt: d.created_at,
  lastSeenAt: d.last_seen_at,
  ownerId: d.owner_id,
});

const sanitizeCaps = (caps: readonly string[] | undefined): Permission[] => {
  const set = new Set<Permission>();
  for (const c of caps ?? DEFAULT_CAPS) if ((PERMISSIONS as readonly string[]).includes(c)) set.add(c as Permission);
  return [...set];
};

export class DeviceService {
  constructor(private readonly db: Db, private readonly keys: ServerKeys) {}

  // ---------- association ----------
  createPairingCode(user: AuthUser, name: string, caps?: string[]): { code: string; expiresAt: number } {
    const code = newPairingCode();
    const expiresAt = nowMs() + PAIRING_TTL_MS;
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(nowMs() - 3600_000);
    this.db
      .prepare('INSERT INTO pairing_codes (code_hash, owner_id, name, caps, expires_at) VALUES (?,?,?,?,?)')
      .run(hashToken(code), user.id, name, JSON.stringify(sanitizeCapsForUser(user, caps)), expiresAt);
    return { code, expiresAt };
  }

  /** Appel public (limite de debit). Le code est a usage unique : il est consomme ici, l'appareil reste 'pending' jusqu'a validation. */
  registerDevice(input: { code: string; publicKey: string; model?: string; os?: string }): { deviceId: string; serverPublicKey: string } {
    if (!isValidDevicePublicKey(input.publicKey)) throw new HttpError(400, 'Cle publique invalide (ECDSA P-256 SPKI attendue)');
    const row = this.db.prepare('SELECT owner_id, name, caps, expires_at, used_at FROM pairing_codes WHERE code_hash = ?').get(hashToken(input.code.toUpperCase().trim())) as
      | { owner_id: string; name: string; caps: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.used_at || row.expires_at < nowMs()) throw new HttpError(400, 'Code d\'association invalide ou expire');
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      const upd = this.db.prepare('UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL').run(nowMs(), id, hashToken(input.code.toUpperCase().trim()));
      if (Number(upd.changes) !== 1) throw new HttpError(400, 'Code d\'association invalide ou expire');
      this.db
        .prepare("INSERT INTO devices (id, owner_id, name, model, os, public_key, caps, status, created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)")
        .run(id, row.owner_id, row.name, (input.model ?? '').slice(0, 80) || null, (input.os ?? '').slice(0, 40) || null, input.publicKey, row.caps, nowMs());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { deviceId: id, serverPublicKey: this.keys.publicKeyB64 };
  }

  approve(user: AuthUser, deviceId: string, patch: { name?: string; caps?: string[] }): DeviceView {
    const d = this.requireManageable(user, deviceId);
    if (d.status !== 'pending') throw new HttpError(409, 'Appareil deja valide ou revoque');
    const pairedAt = (this.db.prepare('SELECT used_at FROM pairing_codes WHERE device_id = ?').get(deviceId) as { used_at: number } | undefined)?.used_at ?? 0;
    if (pairedAt + PAIRING_TTL_MS < nowMs()) {
      this.db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
      throw new HttpError(410, 'Demande d\'association expiree');
    }
    const caps = patch.caps ? JSON.stringify(sanitizeCapsForUser(user, patch.caps)) : d.caps;
    this.db.prepare("UPDATE devices SET status = 'active', name = ?, caps = ? WHERE id = ?").run(patch.name ?? d.name, caps, deviceId);
    return view(this.get(deviceId) as DeviceRow);
  }

  // ---------- acces ----------
  get(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  list(user: AuthUser): DeviceView[] {
    const rows =
      user.role === 'admin'
        ? (this.db.prepare("SELECT * FROM devices WHERE status != 'revoked' ORDER BY created_at").all() as unknown as DeviceRow[])
        : (this.db
            .prepare("SELECT d.* FROM devices d WHERE d.status != 'revoked' AND (d.owner_id = ? OR EXISTS (SELECT 1 FROM device_grants g WHERE g.device_id = d.id AND g.user_id = ?)) ORDER BY d.created_at")
            .all(user.id, user.id) as unknown as DeviceRow[]);
    return rows.map(view);
  }

  /** Utilisateurs ayant un acces (quel qu'il soit) a l'appareil : sert a diffuser les evenements temps reel. */
  usersWithAccess(deviceId: string): string[] {
    const d = this.get(deviceId);
    if (!d) return [];
    const ids = new Set<string>([d.owner_id]);
    for (const r of this.db.prepare('SELECT user_id FROM device_grants WHERE device_id = ?').all(deviceId) as { user_id: string }[]) ids.add(r.user_id);
    for (const r of this.db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0").all() as { id: string }[]) ids.add(r.id);
    return [...ids];
  }

  /** Permissions effectives d'un utilisateur sur un appareil. */
  effectivePerms(user: { id: string; role: string }, d: DeviceRow): Permission[] {
    const caps = JSON.parse(d.caps) as Permission[];
    if (user.role === 'admin' || d.owner_id === user.id) return caps;
    const g = this.db.prepare('SELECT perms FROM device_grants WHERE user_id = ? AND device_id = ?').get(user.id, d.id) as { perms: string } | undefined;
    if (!g) return [];
    const granted = new Set(JSON.parse(g.perms) as string[]);
    return caps.filter((c) => granted.has(c));
  }

  requireAccess(user: AuthUser, deviceId: string, perm?: Permission): DeviceRow {
    const d = this.get(deviceId);
    // 404 identique que l'appareil n'existe pas ou que l'utilisateur n'y a pas acces : pas d'enumeration.
    if (!d || d.status === 'revoked') throw new HttpError(404, 'Appareil introuvable');
    const perms = this.effectivePerms(user, d);
    if (perms.length === 0 && user.role !== 'admin' && d.owner_id !== user.id) throw new HttpError(404, 'Appareil introuvable');
    if (perm && !perms.includes(perm)) throw new HttpError(403, `Permission manquante : ${perm}`);
    return d;
  }

  private requireManageable(user: AuthUser, deviceId: string): DeviceRow {
    const d = this.get(deviceId);
    if (!d || (user.role !== 'admin' && d.owner_id !== user.id)) throw new HttpError(404, 'Appareil introuvable');
    return d;
  }

  update(user: AuthUser, deviceId: string, patch: { name?: string; caps?: string[] }): DeviceView {
    const d = this.requireManageable(user, deviceId);
    if (patch.caps && user.role !== 'admin') throw new HttpError(403, 'Seul un administrateur peut modifier les capacites d\'un appareil');
    this.db.prepare('UPDATE devices SET name = ?, caps = ? WHERE id = ?').run(patch.name ?? d.name, patch.caps ? JSON.stringify(sanitizeCaps(patch.caps)) : d.caps, deviceId);
    return view(this.get(deviceId) as DeviceRow);
  }

  setGrant(deviceId: string, userId: string, perms: string[]): void {
    const clean = sanitizeCaps(perms);
    this.db.prepare('INSERT INTO device_grants (user_id, device_id, perms) VALUES (?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET perms = excluded.perms').run(userId, deviceId, JSON.stringify(clean));
  }

  removeGrant(deviceId: string, userId: string): void {
    this.db.prepare('DELETE FROM device_grants WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
  }

  revoke(user: AuthUser, deviceId: string): void {
    this.requireManageable(user, deviceId);
    this.db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?").run(nowMs(), deviceId);
    this.db.prepare("UPDATE commands SET status = 'cancelled' WHERE device_id = ? AND status IN ('queued','sent')").run(deviceId);
  }

  touch(deviceId: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowMs(), deviceId);
  }

  // ---------- commandes ----------
  /** Cree, signe et met en file une commande. Verifie la permission et la validite de la charge utile. */
  createCommand(user: AuthUser | null, deviceId: string, type: CommandType, rawPayload: unknown): CommandEnvelope {
    const spec = COMMANDS[type];
    const d = user ? this.requireAccess(user, deviceId, spec.perm) : this.get(deviceId);
    if (!d || d.status !== 'active') throw new HttpError(409, 'Appareil non actif');
    const parsed = spec.payload.safeParse(rawPayload ?? {});
    if (!parsed.success) throw new HttpError(400, 'Charge utile invalide : ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join(', '));
    const payload = JSON.stringify(parsed.data);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = (this.db.prepare('SELECT next_seq FROM devices WHERE id = ?').get(deviceId) as { next_seq: number }).next_seq;
      this.db.prepare('UPDATE devices SET next_seq = next_seq + 1 WHERE id = ?').run(deviceId);
      const ts = nowMs();
      const base = { v: PROTOCOL_VERSION, id: randomUUID(), type, deviceId, ts, exp: ts + spec.ttlMs, seq, nonce: newToken(16), payload };
      const env: CommandEnvelope = { ...base, sig: this.keys.sign(envelopeSigningString(base, sha256Hex(payload))) };
      this.db
        .prepare('INSERT INTO commands (id, device_id, user_id, type, envelope, seq, created_at, exp) VALUES (?,?,?,?,?,?,?,?)')
        .run(env.id, deviceId, user?.id ?? null, type, JSON.stringify(env), seq, ts, env.exp);
      this.db.exec('COMMIT');
      return env;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Commandes a remettre a l'appareil (non expirees), dans l'ordre des sequences.
   * `includeSent` : a la (re)connexion, les commandes deja envoyees mais jamais acquittees sont renvoyees
   * (l'appareil les ecarte s'il les a deja traitees grace a leur numero de sequence).
   */
  pendingCommands(deviceId: string, includeSent: boolean): CommandEnvelope[] {
    const now = nowMs();
    this.db.prepare("UPDATE commands SET status = 'expired' WHERE device_id = ? AND status IN ('queued','sent') AND exp < ?").run(deviceId, now);
    const statuses = includeSent ? "('queued','sent')" : "('queued')";
    const rows = this.db.prepare(`SELECT envelope FROM commands WHERE device_id = ? AND status IN ${statuses} ORDER BY seq`).all(deviceId) as { envelope: string }[];
    return rows.map((r) => JSON.parse(r.envelope) as CommandEnvelope);
  }

  markSent(commandId: string): void {
    this.db.prepare("UPDATE commands SET status = 'sent', delivered_at = ? WHERE id = ? AND status = 'queued'").run(nowMs(), commandId);
  }

  ack(deviceId: string, commandId: string, status: 'received' | 'done' | 'error', error?: string): void {
    const st = status === 'received' ? 'received' : status === 'done' ? 'done' : 'failed';
    this.db
      .prepare("UPDATE commands SET status = ?, ack_at = ?, error = ? WHERE id = ? AND device_id = ? AND status IN ('queued','sent','received')")
      .run(st, nowMs(), error ?? null, commandId, deviceId);
  }

  recentTrackCommands(deviceId: string, since: number): CommandEnvelope[] {
    const rows = this.db
      .prepare("SELECT envelope FROM commands WHERE device_id = ? AND type IN ('playback.play','download.manifest') AND created_at > ?")
      .all(deviceId, since) as { envelope: string }[];
    return rows.map((r) => JSON.parse(r.envelope) as CommandEnvelope);
  }

  commandHistory(deviceId: string, limit = 50): unknown[] {
    return this.db
      .prepare('SELECT id, type, status, created_at AS createdAt, ack_at AS ackAt, error FROM commands WHERE device_id = ? ORDER BY seq DESC LIMIT ?')
      .all(deviceId, Math.min(limit, 200));
  }
}

/** Seul un administrateur peut accorder les permissions d'ecran (visualisation, controle). */
function sanitizeCapsForUser(user: AuthUser, caps: readonly string[] | undefined): Permission[] {
  const clean = sanitizeCaps(caps);
  return user.role === 'admin' ? clean : clean.filter((c) => c !== 'screen.view' && c !== 'screen.control');
}
