import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { Audit } from './audit.js';
import { AuthService, HttpError, type AuthUser } from './auth.js';
import { loadOrCreateServerKeys } from './crypto.js';
import { DeviceService } from './devices.js';
import { NavidromeClient, NavidromeError, isValidId } from './navidrome.js';
import { ManifestService } from './downloads.js';
import { LinkService, registerStreamGateway } from './streams.js';
import { Hub } from './realtime.js';
import { permissionSchema, playbackModeSchema } from './protocol.js';

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  auth: AuthService;
  devices: DeviceService;
  hub: Hub;
  audit: Audit;
  nav: NavidromeClient;
}

const username = z.string().min(3).max(40).regex(/^[A-Za-z0-9._-]+$/);
const deviceName = z.string().trim().min(1).max(60);
const capsSchema = z.array(permissionSchema).max(10);

export async function buildApp(config: Config, opts: { db?: Db; fetchImpl?: typeof fetch } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.range'] },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    // Les liens signes (/s/<charge>.<signature>) depassent la limite par defaut de 100 caracteres.
    routerOptions: { maxParamLength: 512 },
    genReqId: () => randomUUID(),
  });
  const db = opts.db ?? openDb(config.dataDir);
  const audit = new Audit(db);
  const auth = new AuthService(db);
  const keys = loadOrCreateServerKeys(config.dataDir);
  const devices = new DeviceService(db, keys);
  const nav = new NavidromeClient(config.navidromeUrl, config.navidromeUser, config.navidromePassword, opts.fetchImpl);
  const manifests = new ManifestService(db, nav);
  const links = new LinkService(config.streamSecrets, config.streamBaseUrl);
  const hub = new Hub(devices, auth, audit, links, app.log);
  const startedAt = Date.now();

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts: { maxAge: 63072000, includeSubDomains: true }, referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // CORS : aucune origine par defaut (les applications mobiles n'en ont pas besoin).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Requete invalide', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof NavidromeError) return reply.code(err.status).send({ error: err.message });
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.statusCode === 429 ? 'Trop de requetes' : 'Requete invalide' });
    req.log.error({ err }, 'erreur interne');
    return reply.code(500).send({ error: 'Erreur interne' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Introuvable' }));

  // ---- gardes ----
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const user = token ? auth.authenticate(token) : null;
    if (!user) return reply.code(401).send({ error: 'Authentification requise' });
    req.user = user;
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'Reserve aux administrateurs' });
  };
  const me = (req: FastifyRequest): AuthUser => req.user as AuthUser;
  const mult = config.env === 'test' ? config.rateLimitMultiplier : 1;
  const strict = (max: number, timeWindow = '1 minute') => ({ rateLimit: { max: max * mult, timeWindow } });

  // ---- sante ----
  app.get('/api/health', async (_req, reply) => {
    try { db.prepare('SELECT 1').get(); } catch { return reply.code(503).send({ status: 'error' }); }
    return { status: 'ok' };
  });
  app.get('/api/status', { preHandler: requireAdmin }, async () => {
    let navidrome = false;
    try { navidrome = await nav.ping(); } catch { /* indisponible */ }
    const counts = hub.onlineCount();
    return { version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000), navidrome, connectedDevices: counts.devices, connectedControllers: counts.controllers, relayEnabled: config.relayEnabled };
  });

  // ---- authentification ----
  app.post('/api/auth/login', { config: strict(10) }, async (req, reply) => {
    const body = z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(256) }).parse(req.body);
    const r = await auth.login(body.identifier, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if ('error' in r) {
      audit.log({ actorType: 'user', actorId: r.userId, action: r.error === 'locked' ? 'auth.login_locked' : 'auth.login_failed', ip: req.ip });
      // Reponse identique : ni enumeration de comptes, ni indication de verrouillage.
      return reply.code(401).send({ error: 'Identifiant ou mot de passe incorrect, ou compte temporairement verrouille' });
    }
    audit.log({ actorType: 'user', actorId: r.user.id, action: 'auth.login', ip: req.ip });
    return { ...r.tokens, user: { id: r.user.id, username: r.user.username, role: r.user.role } };
  });
  app.post('/api/auth/refresh', { config: strict(30) }, async (req, reply) => {
    const body = z.object({ refreshToken: z.string().min(10).max(200) }).parse(req.body);
    const r = auth.refresh(body.refreshToken, { ip: req.ip });
    if ('error' in r) {
      if (r.error === 'reuse') audit.log({ actorType: 'user', actorId: r.userId, action: 'auth.refresh_reuse_detected', ip: req.ip });
      return reply.code(401).send({ error: 'Session invalide' });
    }
    return r.tokens;
  });
  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    auth.revokeSession(me(req).sessionId);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'auth.logout', ip: req.ip });
    return reply.code(204).send();
  });
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({ id: me(req).id, username: me(req).username, role: me(req).role }));
  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => ({ sessions: auth.listSessions(me(req).id), current: me(req).sessionId }));
  app.delete('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    if (!auth.revokeSession(id, me(req).id)) return reply.code(404).send({ error: 'Session introuvable' });
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'auth.session_revoked', target: id, ip: req.ip });
    return reply.code(204).send();
  });
  app.post('/api/auth/password', { preHandler: requireAuth, config: strict(5) }, async (req, reply) => {
    const b = z.object({ current: z.string().max(256), next: z.string().max(256) }).parse(req.body);
    await auth.changePassword(me(req).id, b.current, b.next);
    auth.revokeAllSessions(me(req).id, me(req).sessionId);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'auth.password_changed', ip: req.ip });
    return reply.code(204).send();
  });
  app.post('/api/auth/reset', { config: strict(5) }, async (req, reply) => {
    const b = z.object({ token: z.string().min(10).max(200), newPassword: z.string().max(256) }).parse(req.body);
    const userId = await auth.resetWithToken(b.token, b.newPassword);
    audit.log({ actorType: 'user', actorId: userId, action: 'auth.password_reset', ip: req.ip });
    return reply.code(204).send();
  });

  // ---- utilisateurs (admin) ----
  app.get('/api/users', { preHandler: requireAdmin }, async () => ({ users: auth.listUsers() }));
  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ username, email: z.email().max(254).optional(), password: z.string().max(256), role: z.enum(['admin', 'user']).default('user') }).parse(req.body);
    const u = await auth.createUser(b);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'user.create', target: u.id, ip: req.ip, details: { role: u.role } });
    return reply.code(201).send(u);
  });
  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional() }).parse(req.body);
    auth.updateUser(id, b);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'user.update', target: id, ip: req.ip, details: b });
    return auth.getUser(id);
  });
  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    auth.deleteUser(id);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'user.delete', target: id, ip: req.ip });
    return reply.code(204).send();
  });
  app.post('/api/users/:id/reset-token', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    if (!auth.getUser(id)) throw new HttpError(404, 'Utilisateur introuvable');
    const token = auth.issueResetToken(id);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'user.reset_token_issued', target: id, ip: req.ip });
    return { token, expiresInSec: 1800 };
  });

  // ---- association et appareils ----
  app.post('/api/pairing/codes', { preHandler: requireAuth, config: strict(20) }, async (req) => {
    const b = z.object({ name: deviceName, caps: capsSchema.optional() }).parse(req.body);
    const r = devices.createPairingCode(me(req), b.name, b.caps);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'pairing.code_created', ip: req.ip });
    return r;
  });
  app.post('/api/pairing/register', { config: strict(10) }, async (req) => {
    const b = z.object({ code: z.string().min(6).max(16), publicKey: z.string().min(50).max(300), model: z.string().max(80).optional(), os: z.string().max(40).optional() }).parse(req.body);
    const r = devices.registerDevice(b);
    audit.log({ actorType: 'device', actorId: r.deviceId, action: 'pairing.device_registered', target: r.deviceId, ip: req.ip, details: { model: b.model, os: b.os } });
    return r;
  });
  app.post('/api/devices/:id/approve', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ name: deviceName.optional(), caps: capsSchema.optional() }).parse(req.body ?? {});
    const d = devices.approve(me(req), id, b);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'device.approve', target: id, ip: req.ip, details: { caps: d.caps } });
    hub.notifyApproved(id);
    return d;
  });
  app.get('/api/devices', { preHandler: requireAuth }, async (req) => ({
    devices: devices.list(me(req)).map((d) => ({ ...d, online: hub.isDeviceOnline(d.id), state: hub.getPresence(d.id)?.state ?? {} })),
  }));
  app.get('/api/devices/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const d = devices.requireAccess(me(req), id);
    const v = devices.list(me(req)).find((x) => x.id === d.id) ?? { id: d.id, name: d.name, status: d.status };
    return { ...v, online: hub.isDeviceOnline(id), state: hub.getPresence(id)?.state ?? {}, permissions: devices.effectivePerms(me(req), d) };
  });
  app.patch('/api/devices/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ name: deviceName.optional(), caps: capsSchema.optional() }).parse(req.body);
    const d = devices.update(me(req), id, b);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'device.update', target: id, ip: req.ip, details: b });
    return d;
  });
  app.post('/api/devices/:id/revoke', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    hub.revokeDevice(me(req), id, req.ip);
    return reply.code(204).send();
  });
  app.delete('/api/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    hub.revokeDevice(me(req), id, req.ip);
    return reply.code(204).send();
  });
  app.put('/api/devices/:id/grants/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: z.string().max(64), userId: z.string().max(64) }).parse(req.params);
    const b = z.object({ perms: capsSchema }).parse(req.body);
    if (!devices.get(p.id) || !auth.getUser(p.userId)) throw new HttpError(404, 'Introuvable');
    devices.setGrant(p.id, p.userId, b.perms);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'device.grant', target: p.id, ip: req.ip, details: { userId: p.userId, perms: b.perms } });
    return reply.code(204).send();
  });
  app.delete('/api/devices/:id/grants/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: z.string().max(64), userId: z.string().max(64) }).parse(req.params);
    devices.removeGrant(p.id, p.userId);
    audit.log({ actorType: 'user', actorId: me(req).id, action: 'device.grant_removed', target: p.id, ip: req.ip, details: { userId: p.userId } });
    return reply.code(204).send();
  });
  app.get('/api/devices/:id/history', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    devices.requireAccess(me(req), id, 'device.status');
    return { events: audit.list({ limit: 100, target: id }), commands: devices.commandHistory(id) };
  });
  app.post('/api/devices/:id/commands', { preHandler: requireAuth, config: strict(120) }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ type: z.string().max(40), payload: z.unknown().optional() }).parse(req.body);
    const env = hub.sendCommand(me(req), id, b.type, b.payload, req.ip);
    return reply.code(202).send({ commandId: env.id, expiresAt: env.exp });
  });

  // Envoi d'une playlist Navidrome vers un telephone (flux, telechargement ou hybride)
  app.post('/api/devices/:id/playlists/:playlistId/send', { preHandler: requireAuth, config: strict(30) }, async (req, reply) => {
    const p = z.object({ id: z.string().max(64), playlistId: z.string().max(64) }).parse(req.params);
    const b = z.object({ mode: playbackModeSchema, play: z.boolean().default(true), startIndex: z.number().int().min(0).default(0) }).parse(req.body);
    if (!isValidId(p.playlistId)) throw new HttpError(400, 'Identifiant de playlist invalide');
    const user = me(req);
    devices.requireAccess(user, p.id, 'music.send');
    if (!hub.isDeviceOnline(p.id) && b.mode !== 'stream') throw new HttpError(409, 'L\'appareil doit etre connecte pour recevoir une playlist');
    if (b.mode === 'stream') {
      const pl = await nav.playlist(p.playlistId);
      const trackIds = (pl.songs ?? []).map((s) => s.id);
      if (trackIds.length === 0) throw new HttpError(409, 'Playlist vide');
      const env = hub.sendCommand(user, p.id, 'playback.play', { playlistId: p.playlistId, trackIds, startIndex: b.startIndex, mode: 'stream' }, req.ip);
      return reply.code(202).send({ status: 'sent', commandId: env.id });
    }
    // Telechargement / hybride : le calcul des empreintes peut etre long, on repond tout de suite et on informe en temps reel.
    void (async () => {
      try {
        const { tracks, totalBytes } = await manifests.build(p.playlistId, (done, total) => hub.broadcastDownloadProgress(p.id, { playlistId: p.playlistId, phase: 'preparing', done, total }));
        hub.sendCommand(user, p.id, 'download.manifest', { playlistId: p.playlistId, tracks, autoplay: false }, req.ip);
        if (b.mode === 'hybrid' && b.play) hub.sendCommand(user, p.id, 'playback.play', { playlistId: p.playlistId, trackIds: tracks.map((t) => t.id), startIndex: b.startIndex, mode: 'hybrid' }, req.ip);
        hub.broadcastDownloadProgress(p.id, { playlistId: p.playlistId, phase: 'sent', total: tracks.length, bytes: totalBytes });
      } catch (e) {
        app.log.warn({ err: e }, 'preparation du manifeste impossible');
        hub.broadcastDownloadProgress(p.id, { playlistId: p.playlistId, phase: 'error', error: e instanceof Error ? e.message : 'Erreur' });
      }
    })();
    return reply.code(202).send({ status: 'preparing' });
  });

  // ---- bibliotheque Navidrome (via le serveur : aucun identifiant Navidrome cote application) ----
  const lib = { preHandler: requireAuth };
  app.get('/api/library/artists', lib, async () => ({ artists: await nav.artists() }));
  app.get('/api/library/artists/:id', lib, async (req) => nav.artist((req.params as { id: string }).id));
  app.get('/api/library/albums/:id', lib, async (req) => nav.albumById((req.params as { id: string }).id));
  app.get('/api/library/playlists', lib, async () => ({ playlists: await nav.playlists() }));
  app.get('/api/library/playlists/:id', lib, async (req) => nav.playlist((req.params as { id: string }).id));
  app.get('/api/library/search', { ...lib, config: strict(60) }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    return nav.search(q);
  });
  app.get('/api/library/cover/:id', lib, async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).parse(req.params);
    const size = z.coerce.number().int().min(32).max(1200).default(300).parse((req.query as { size?: string }).size);
    const up = await nav.fetchRaw(nav.upstreamUrl('getCoverArt', id, { size: String(size) }));
    const ct = up.headers.get('content-type') ?? '';
    if (!up.ok || !up.body || !ct.startsWith('image/')) return reply.code(404).send({ error: 'Pochette introuvable' });
    reply.header('content-type', ct).header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff');
    return reply.send(Buffer.from(await up.arrayBuffer()));
  });

  // ---- audit (admin) ----
  app.get('/api/audit', { preHandler: requireAdmin }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() }).parse(req.query);
    return { events: audit.list(q) };
  });

  // ---- temps reel et passerelle de flux ----
  hub.registerRoutes(app);
  if (config.relayEnabled) {
    registerStreamGateway(app, {
      navidrome: nav,
      secrets: config.streamSecrets,
      isDeviceActive: (id) => devices.get(id)?.status === 'active',
      onTransfer: (i) => { if (i.kind !== 'cover') audit.log({ actorType: 'device', actorId: i.deviceId, action: 'relay.transfer', target: i.deviceId, details: { kind: i.kind, status: i.status } }); },
    });
  }

  app.addHook('onClose', async () => hub.closeAll());
  return { app, db, auth, devices, hub, audit, nav };
}
