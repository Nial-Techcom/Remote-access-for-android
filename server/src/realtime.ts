import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Audit } from './audit.js';
import type { AuthService, AuthUser } from './auth.js';
import { HttpError } from './auth.js';
import type { DeviceService } from './devices.js';
import { newToken, verifyDeviceSignature } from './crypto.js';
import { controllerMessageSchema, deviceAuthString, deviceMessageSchema, isCommandType, type CommandEnvelope, type CommandType, type DeviceState } from './protocol.js';
import type { LinkService } from './streams.js';
import { nowMs } from './db.js';
import { z } from 'zod';

const AUTH_TIMEOUT_MS = 8_000;
const AUTH_MAX_SKEW_MS = 2 * 60_000;
const MAX_MSG_PER_10S = 60;

interface DeviceConn { ws: WebSocket; deviceId: string; active: boolean; lastPong: number }
interface ControllerConn { ws: WebSocket; user: AuthUser }
interface Presence { online: boolean; state: DeviceState; updatedAt: number }

const controllerCommand = z.object({ type: z.literal('command'), reqId: z.string().max(64), deviceId: z.string().max(64), cmd: z.string().max(40), payload: z.unknown().optional() });

export class Hub {
  private devices = new Map<string, DeviceConn>();
  private controllers = new Set<ControllerConn>();
  private presence = new Map<string, Presence>();
  private screenSessions = new Map<string, { deviceId: string; userId: string }>();
  private allowed = new Map<string, Set<string>>();
  private closing = false;

  constructor(
    private readonly devs: DeviceService,
    private readonly auth: AuthService,
    private readonly audit: Audit,
    private readonly links: LinkService,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void },
  ) {}

  // ---------- API utilisee par les routes REST ----------
  getPresence(deviceId: string): Presence | undefined { return this.presence.get(deviceId); }
  onlineCount(): { devices: number; controllers: number } { return { devices: this.devices.size, controllers: this.controllers.size }; }
  isDeviceOnline(id: string): boolean { return this.devices.has(id); }

  /** Point d'entree unique pour envoyer une commande (REST ou WebSocket) : permission, signature, audit, livraison. */
  sendCommand(user: AuthUser, deviceId: string, type: string, payload: unknown, ip?: string): CommandEnvelope {
    if (!isCommandType(type)) throw new HttpError(400, 'Type de commande inconnu');
    if (type === 'device.revoked') throw new HttpError(400, 'Commande reservee au serveur');
    const env = this.devs.createCommand(user, deviceId, type, payload);
    this.rememberAllowed(deviceId, type, env.payload);
    if (type === 'screen.start') {
      const p = JSON.parse(env.payload) as { sessionId: string };
      this.screenSessions.set(p.sessionId, { deviceId, userId: user.id });
      this.audit.log({ actorType: 'user', actorId: user.id, action: 'screen.start', target: deviceId, ip, details: { sessionId: p.sessionId } });
    } else if (type === 'screen.stop') {
      const p = JSON.parse(env.payload) as { sessionId: string };
      this.screenSessions.delete(p.sessionId);
      this.audit.log({ actorType: 'user', actorId: user.id, action: 'screen.stop', target: deviceId, ip, details: { sessionId: p.sessionId } });
    } else if (type === 'input.gesture') {
      // Les gestes ne sont pas journalises un par un (volume), seule la session l'est (screen.start).
    } else if (type !== 'screen.signal') {
      this.audit.log({ actorType: 'user', actorId: user.id, action: `command.${type}`, target: deviceId, ip });
    }
    this.deliverPending(deviceId);
    return env;
  }

  /** Revocation immediate : previent l'appareil puis coupe la connexion et tout partage d'ecran. */
  revokeDevice(user: AuthUser, deviceId: string, ip?: string): void {
    const conn = this.devices.get(deviceId);
    const d = this.devs.get(deviceId);
    if (conn && d?.status === 'active') {
      // Commande signee envoyee hors file pour que l'appareil nettoie ses donnees avant la coupure.
      try {
        const env = this.devs.createCommand(null, deviceId, 'device.revoked', {});
        this.sendRaw(conn.ws, { type: 'command', command: env });
      } catch { /* l'appareil sera coupe de toute facon */ }
    }
    this.devs.revoke(user, deviceId);
    for (const [sid, s] of this.screenSessions) if (s.deviceId === deviceId) this.screenSessions.delete(sid);
    this.audit.log({ actorType: 'user', actorId: user.id, action: 'device.revoke', target: deviceId, ip });
    setTimeout(() => this.devices.get(deviceId)?.ws.close(4001, 'revoked'), 200).unref();
    this.broadcastToDeviceUsers(deviceId, { type: 'device.revoked', deviceId });
  }

  notifyApproved(deviceId: string): void {
    const c = this.devices.get(deviceId);
    if (c) { c.active = true; this.sendRaw(c.ws, { type: 'pairing.approved' }); this.deliverPending(deviceId, true); }
  }

  kick(deviceId: string): void { this.devices.get(deviceId)?.ws.close(4001, 'revoked'); }

  broadcastDownloadProgress(deviceId: string, data: object): void { this.broadcastToDeviceUsers(deviceId, { type: 'download.progress', deviceId, ...data }); }

  // ---------- Pistes autorisees par appareil ----------
  private rememberAllowed(deviceId: string, type: CommandType, payload: string): void {
    if (type !== 'playback.play' && type !== 'download.manifest') return;
    const set = this.allowedFor(deviceId);
    const p = JSON.parse(payload) as { trackIds?: string[]; tracks?: { id: string }[] };
    for (const id of p.trackIds ?? []) set.add(id);
    for (const t of p.tracks ?? []) set.add(t.id);
  }
  private allowedFor(deviceId: string): Set<string> {
    let set = this.allowed.get(deviceId);
    if (!set) {
      set = new Set();
      this.allowed.set(deviceId, set);
      const since = nowMs() - 7 * 24 * 3600_000;
      for (const env of this.devs.recentTrackCommands(deviceId, since)) this.rememberAllowed(deviceId, env.type, env.payload);
    }
    return set;
  }

  // ---------- Diffusion ----------
  private sendRaw(ws: WebSocket, msg: object): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) { ws.close(1013, 'slow consumer'); return; }
    ws.send(JSON.stringify(msg));
  }
  private broadcastToDeviceUsers(deviceId: string, msg: object): void {
    const users = new Set(this.devs.usersWithAccess(deviceId));
    for (const c of this.controllers) if (users.has(c.user.id)) this.sendRaw(c.ws, msg);
  }

  private deliverPending(deviceId: string, includeSent = false): void {
    const conn = this.devices.get(deviceId);
    if (!conn || !conn.active) return;
    for (const env of this.devs.pendingCommands(deviceId, includeSent)) {
      this.sendRaw(conn.ws, { type: 'command', command: env });
      this.devs.markSent(env.id);
    }
  }

  // ---------- WebSocket appareil ----------
  registerRoutes(app: FastifyInstance): void {
    app.get('/ws/device', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (ws, req) => this.handleDevice(ws, req.ip));
    app.get('/ws/controller', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (ws, req) => this.handleController(ws, req.ip));
  }

  private handleDevice(ws: WebSocket, ip: string): void {
    const nonce = newToken(24);
    let conn: DeviceConn | null = null;
    let count = 0;
    const bucket = setInterval(() => { count = 0; }, 10_000);
    const authTimer = setTimeout(() => { if (!conn) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    this.sendRaw(ws, { type: 'hello', nonce, v: 1 });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'binary not supported');
      if (++count > MAX_MSG_PER_10S) return ws.close(4429, 'rate limit');
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return ws.close(1007, 'invalid json'); }
      const parsed = deviceMessageSchema.safeParse(json);
      if (!parsed.success) return this.sendRaw(ws, { type: 'error', error: 'invalid message' });
      const msg = parsed.data;

      if (!conn) {
        if (msg.type !== 'auth') return ws.close(4401, 'auth required');
        const d = this.devs.get(msg.deviceId);
        const okSig = d && d.status !== 'revoked' && Math.abs(nowMs() - msg.ts) < AUTH_MAX_SKEW_MS && verifyDeviceSignature(d.public_key, deviceAuthString(msg.deviceId, nonce, msg.ts), msg.sig);
        if (!d || !okSig) {
          this.audit.log({ actorType: 'device', actorId: msg.deviceId, action: 'device.auth_failed', target: msg.deviceId, ip });
          return ws.close(4401, 'auth failed');
        }
        clearTimeout(authTimer);
        const old = this.devices.get(d.id);
        if (old) old.ws.close(4000, 'replaced');
        conn = { ws, deviceId: d.id, active: d.status === 'active', lastPong: nowMs() };
        this.devices.set(d.id, conn);
        this.devs.touch(d.id);
        const prev = this.presence.get(d.id);
        this.presence.set(d.id, { online: true, state: prev?.state ?? {}, updatedAt: nowMs() });
        this.audit.log({ actorType: 'device', actorId: d.id, action: 'device.connect', target: d.id, ip });
        this.sendRaw(ws, { type: conn.active ? 'ready' : 'pairing.pending', serverTime: nowMs() });
        this.broadcastToDeviceUsers(d.id, { type: 'device.online', deviceId: d.id });
        this.deliverPending(d.id, true);
        return;
      }
      if (!conn.active) return; // appareil en attente de validation : aucun message utile accepte
      this.onDeviceMessage(conn, msg);
    });
    ws.on('pong', () => { if (conn) conn.lastPong = nowMs(); });
    const hb = setInterval(() => {
      if (conn && nowMs() - conn.lastPong > 70_000) return ws.terminate();
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 25_000);
    ws.on('close', () => {
      clearInterval(hb); clearInterval(bucket); clearTimeout(authTimer);
      if (this.closing) return; // arret du serveur : base et diffusion peuvent deja etre fermees
      if (conn && this.devices.get(conn.deviceId) === conn) {
        this.devices.delete(conn.deviceId);
        const p = this.presence.get(conn.deviceId);
        if (p) this.presence.set(conn.deviceId, { ...p, online: false, updatedAt: nowMs() });
        this.audit.log({ actorType: 'device', actorId: conn.deviceId, action: 'device.disconnect', target: conn.deviceId, ip });
        this.broadcastToDeviceUsers(conn.deviceId, { type: 'device.offline', deviceId: conn.deviceId });
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private onDeviceMessage(conn: DeviceConn, msg: z.infer<typeof deviceMessageSchema>): void {
    const id = conn.deviceId;
    switch (msg.type) {
      case 'ping': return this.sendRaw(conn.ws, { type: 'pong' });
      case 'state': {
        this.devs.touch(id);
        const prev = this.presence.get(id)?.state ?? {};
        const state = { ...prev, ...msg.state };
        this.presence.set(id, { online: true, state, updatedAt: nowMs() });
        return this.broadcastToDeviceUsers(id, { type: 'device.state', deviceId: id, state, updatedAt: nowMs() });
      }
      case 'ack':
        this.devs.ack(id, msg.commandId, msg.status, msg.error);
        return this.broadcastToDeviceUsers(id, { type: 'command.update', deviceId: id, commandId: msg.commandId, status: msg.status, error: msg.error });
      case 'download.progress':
        return this.broadcastDownloadProgress(id, { playlistId: msg.playlistId, done: msg.done, total: msg.total, bytes: msg.bytes, failed: msg.failed });
      case 'links.request': {
        const set = this.allowedFor(id);
        const out: Record<string, { url: string; expiresAt: number } | null> = {};
        for (const tid of msg.ids) {
          // Flux et telechargements : uniquement les pistes qui ont ete envoyees a cet appareil. Pochettes : tout identifiant valide.
          out[tid] = msg.kind === 'cover' || set.has(tid) ? this.links.make(id, msg.kind, tid) : null;
        }
        return this.sendRaw(conn.ws, { type: 'links.response', reqId: msg.reqId, links: out });
      }
      case 'screen.signal': {
        const s = this.screenSessions.get(msg.sessionId);
        if (!s || s.deviceId !== id) return;
        for (const c of this.controllers) if (c.user.id === s.userId) this.sendRaw(c.ws, { type: 'screen.signal', deviceId: id, sessionId: msg.sessionId, kind: msg.kind, data: msg.data });
        return;
      }
      case 'auth': return;
    }
  }

  // ---------- WebSocket Controller ----------
  private handleController(ws: WebSocket, ip: string): void {
    let conn: ControllerConn | null = null;
    let count = 0;
    const bucket = setInterval(() => { count = 0; }, 10_000);
    const authTimer = setTimeout(() => { if (!conn) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'binary not supported');
      if (++count > 200) return ws.close(4429, 'rate limit');
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return ws.close(1007, 'invalid json'); }
      if (!conn) {
        const a = controllerMessageSchema.safeParse(json);
        if (!a.success || a.data.type !== 'auth') return ws.close(4401, 'auth required');
        const user = this.auth.authenticate(a.data.token); // jeton dans le premier message, jamais dans l'URL
        if (!user) return ws.close(4401, 'auth failed');
        clearTimeout(authTimer);
        conn = { ws, user };
        this.controllers.add(conn);
        const devices = this.devs.list(user).map((d) => ({ ...d, online: this.devices.has(d.id), state: this.presence.get(d.id)?.state ?? {} }));
        return this.sendRaw(ws, { type: 'ready', user: { id: user.id, username: user.username, role: user.role }, devices });
      }
      // Le jeton peut expirer pendant la connexion : on le revalide a chaque message sensible via la session.
      if (!this.auth.authenticateSession(conn.user.sessionId)) return ws.close(4401, 'session expired');
      const parsed = controllerCommand.safeParse(json);
      if (!parsed.success) {
        const base = controllerMessageSchema.safeParse(json);
        if (base.success && base.data.type === 'ping') return this.sendRaw(ws, { type: 'pong' });
        return this.sendRaw(ws, { type: 'error', error: 'invalid message' });
      }
      const m = parsed.data;
      try {
        const env = this.sendCommand(conn.user, m.deviceId, m.cmd, m.payload, ip);
        this.sendRaw(ws, { type: 'command.result', reqId: m.reqId, ok: true, commandId: env.id });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        this.sendRaw(ws, { type: 'command.result', reqId: m.reqId, ok: false, status, error: e instanceof HttpError ? e.message : 'Erreur interne' });
      }
    });
    ws.on('close', () => { clearInterval(bucket); clearTimeout(authTimer); if (conn) this.controllers.delete(conn); });
    ws.on('error', () => ws.terminate());
  }

  closeAll(): void {
    this.closing = true;
    for (const c of this.devices.values()) c.ws.close(1001, 'shutdown');
    for (const c of this.controllers) c.ws.close(1001, 'shutdown');
  }
}
