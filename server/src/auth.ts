import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { nowMs } from './db.js';
import { hashToken, newToken } from './crypto.js';

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 3600 * 1000;
const MAX_FAILED_BEFORE_LOCK = 5;
const MAX_LOCK_MS = 15 * 60 * 1000;

export type Role = 'admin' | 'user';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  sessionId: string;
}

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  disabled: number;
  created_at: number;
}

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const COMMON_PASSWORDS = new Set([
  'password1234', 'azertyuiop12', 'qwertyuiop12', '123456789012', 'motdepasse12', 'administrator', 'changeme1234',
  'passw0rd1234', 'welcome12345', 'letmein12345', 'iloveyou1234', 'azerty123456', 'password12345', 'motdepasse123',
]);

export function validatePassword(password: string, username: string): string | null {
  if (password.length < 12) return 'Le mot de passe doit contenir au moins 12 caracteres';
  if (password.length > 256) return 'Le mot de passe est trop long (256 caracteres maximum)';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Mot de passe trop courant';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Le mot de passe ne doit pas contenir l\'identifiant';
  if (/^(.)\1+$/.test(password)) return 'Mot de passe trop simple';
  return null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

export class AuthService {
  private dummyHash: Promise<string>;

  constructor(private readonly db: Db) {
    // Hash factice : verifie un mot de passe meme si le compte n'existe pas (temps de reponse constant).
    this.dummyHash = argon2.hash('dummy-password-for-timing', ARGON_OPTS);
  }

  async createUser(input: { username: string; email?: string | null; password: string; role: Role }): Promise<UserRow> {
    const err = validatePassword(input.password, input.username);
    if (err) throw new HttpError(400, err);
    const id = randomUUID();
    const hash = await argon2.hash(input.password, ARGON_OPTS);
    try {
      this.db
        .prepare('INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.username, input.email ?? null, hash, input.role, nowMs());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Identifiant ou e-mail deja utilise');
      throw e;
    }
    return this.getUser(id) as UserRow;
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT id, username, email, role, disabled, created_at FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT id, username, email, role, disabled, created_at FROM users ORDER BY created_at').all() as unknown as UserRow[];
  }

  countAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as { n: number }).n;
  }

  async login(identifier: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<{ tokens: TokenPair; user: UserRow } | { error: 'invalid' | 'locked'; retryAfterSec?: number; userId?: string }> {
    const row = this.db
      .prepare('SELECT id, password_hash, disabled, failed_attempts, locked_until FROM users WHERE username = ? OR email = ?')
      .get(identifier, identifier) as { id: string; password_hash: string; disabled: number; failed_attempts: number; locked_until: number } | undefined;

    const now = nowMs();
    if (row && row.locked_until > now) {
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return { error: 'locked', retryAfterSec: Math.ceil((row.locked_until - now) / 1000), userId: row.id };
    }
    const ok = await argon2.verify(row?.password_hash ?? (await this.dummyHash), password).catch(() => false);
    if (!row || !ok || row.disabled) {
      if (row) {
        const attempts = row.failed_attempts + 1;
        let lockedUntil = 0;
        if (attempts >= MAX_FAILED_BEFORE_LOCK) {
          lockedUntil = now + Math.min(30_000 * 2 ** (attempts - MAX_FAILED_BEFORE_LOCK), MAX_LOCK_MS);
        }
        this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockedUntil, row.id);
      }
      return { error: 'invalid', userId: row?.id };
    }
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(row.id);
    const tokens = this.createSession(row.id, meta);
    return { tokens, user: this.getUser(row.id) as UserRow };
  }

  createSession(userId: string, meta: { ip?: string; userAgent?: string }): TokenPair {
    const now = nowMs();
    const id = randomUUID();
    const access = newToken();
    const refresh = newToken();
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, access_hash, access_exp, refresh_hash, refresh_exp, abs_exp, created_at, last_used_at, user_agent, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, userId, hashToken(access), now + ACCESS_TTL_MS, hashToken(refresh), now + REFRESH_TTL_MS, now + SESSION_ABSOLUTE_MS, now, now, (meta.userAgent ?? '').slice(0, 200), meta.ip ?? null);
    return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL_MS / 1000, sessionId: id };
  }

  /** Rotation du jeton de rafraichissement. Reutilisation d'un ancien jeton = vol suppose : la session est revoquee. */
  refresh(refreshToken: string, meta: { ip?: string }): { tokens: TokenPair } | { error: 'invalid' | 'reuse'; userId?: string } {
    const h = hashToken(refreshToken);
    const now = nowMs();
    const reused = this.db.prepare('SELECT id, user_id FROM sessions WHERE prev_refresh_hash = ? AND revoked_at IS NULL').get(h) as { id: string; user_id: string } | undefined;
    if (reused) {
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, reused.id);
      return { error: 'reuse', userId: reused.user_id };
    }
    const s = this.db
      .prepare('SELECT s.id, s.user_id, s.refresh_exp, s.abs_exp, s.revoked_at, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = ?')
      .get(h) as { id: string; user_id: string; refresh_exp: number; abs_exp: number; revoked_at: number | null; disabled: number } | undefined;
    if (!s || s.revoked_at || s.disabled || s.refresh_exp < now || s.abs_exp < now) return { error: 'invalid' };
    const access = newToken();
    const refresh = newToken();
    this.db
      .prepare('UPDATE sessions SET access_hash=?, access_exp=?, prev_refresh_hash=refresh_hash, refresh_hash=?, refresh_exp=?, last_used_at=?, ip=COALESCE(?, ip) WHERE id=?')
      .run(hashToken(access), now + ACCESS_TTL_MS, hashToken(refresh), Math.min(now + REFRESH_TTL_MS, s.abs_exp), now, meta.ip ?? null, s.id);
    return { tokens: { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL_MS / 1000, sessionId: s.id } };
  }

  authenticate(accessToken: string): AuthUser | null {
    const now = nowMs();
    const row = this.db
      .prepare(
        'SELECT s.id AS sid, s.access_exp, s.abs_exp, s.revoked_at, u.id, u.username, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.access_hash = ?',
      )
      .get(hashToken(accessToken)) as { sid: string; access_exp: number; abs_exp: number; revoked_at: number | null; id: string; username: string; role: Role; disabled: number } | undefined;
    if (!row || row.revoked_at || row.disabled || row.access_exp < now || row.abs_exp < now) return null;
    return { id: row.id, username: row.username, role: row.role, sessionId: row.sid };
  }

  /** La session est-elle toujours valable ? (connexions WebSocket longues : le jeton d'acces a pu expirer entre-temps) */
  authenticateSession(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT s.abs_exp, s.refresh_exp, s.revoked_at, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
      .get(sessionId) as { abs_exp: number; refresh_exp: number; revoked_at: number | null; disabled: number } | undefined;
    const now = nowMs();
    return Boolean(row && !row.revoked_at && !row.disabled && row.abs_exp > now && row.refresh_exp > now);
  }

  revokeSession(sessionId: string, userId?: string): boolean {
    const r = this.db
      .prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL ${userId ? 'AND user_id = ?' : ''}`)
      .run(...([nowMs(), sessionId, ...(userId ? [userId] : [])] as [number, string, ...string[]]));
    return Number(r.changes) > 0;
  }

  revokeAllSessions(userId: string, exceptSessionId?: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?').run(nowMs(), userId, exceptSessionId ?? '');
  }

  listSessions(userId: string): unknown[] {
    return this.db
      .prepare('SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt, ip, user_agent AS userAgent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND abs_exp > ? ORDER BY last_used_at DESC')
      .all(userId, nowMs());
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const row = this.db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(userId) as { username: string; password_hash: string } | undefined;
    if (!row || !(await argon2.verify(row.password_hash, current).catch(() => false))) throw new HttpError(403, 'Mot de passe actuel incorrect');
    await this.setPassword(userId, row.username, next);
  }

  private async setPassword(userId: string, username: string, next: string): Promise<void> {
    const err = validatePassword(next, username);
    if (err) throw new HttpError(400, err);
    const hash = await argon2.hash(next, ARGON_OPTS);
    this.db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0, reset_hash = NULL, reset_exp = NULL WHERE id = ?').run(hash, userId);
  }

  /** Reinitialisation emise par un administrateur (pas de SMTP requis). Jeton a usage unique, 30 minutes. */
  issueResetToken(userId: string): string {
    const token = newToken();
    this.db.prepare('UPDATE users SET reset_hash = ?, reset_exp = ? WHERE id = ?').run(hashToken(token), nowMs() + 30 * 60 * 1000, userId);
    return token;
  }

  async resetWithToken(token: string, newPassword: string): Promise<string> {
    const row = this.db.prepare('SELECT id, username, reset_exp FROM users WHERE reset_hash = ?').get(hashToken(token)) as { id: string; username: string; reset_exp: number } | undefined;
    if (!row || row.reset_exp < nowMs()) throw new HttpError(400, 'Jeton de reinitialisation invalide ou expire');
    await this.setPassword(row.id, row.username, newPassword);
    this.revokeAllSessions(row.id);
    return row.id;
  }

  updateUser(id: string, patch: { role?: Role; disabled?: boolean }): void {
    const u = this.getUser(id);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    const newRole = patch.role ?? u.role;
    const newDisabled = patch.disabled ?? Boolean(u.disabled);
    if (u.role === 'admin' && (newRole !== 'admin' || newDisabled) && this.countAdmins() <= 1) {
      throw new HttpError(409, 'Impossible : il doit rester au moins un administrateur actif');
    }
    this.db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(newRole, newDisabled ? 1 : 0, id);
    if (newDisabled) this.revokeAllSessions(id);
  }

  deleteUser(id: string): void {
    const u = this.getUser(id);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    if (u.role === 'admin' && this.countAdmins() <= 1) throw new HttpError(409, 'Impossible de supprimer le dernier administrateur');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
