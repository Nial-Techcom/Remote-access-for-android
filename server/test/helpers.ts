import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, sign as nodeSign, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildApp, type AppContext } from '../src/app.js';
import type { Config } from '../src/config.js';
import { deviceAuthString, envelopeSigningString, type CommandEnvelope } from '../src/protocol.js';
import { sha256Hex } from '../src/crypto.js';

export const NAV_USER = 'nial-service';
export const NAV_PASS = 'navidrome-secret-password-DO-NOT-LEAK';
export const STREAM_SECRET = 'test-stream-secret-0123456789-abcdefghijklmnop';

export const SONGS: Record<string, Buffer> = {
  s1: Buffer.from('audio-data-one-'.repeat(2000)),
  s2: Buffer.from('audio-data-two-'.repeat(3000)),
  s3: Buffer.from('audio-data-three-'.repeat(1000)),
};

export interface MockNav { server: Server; url: string; downloads: Record<string, number>; close: () => Promise<void> }

/** Faux Navidrome : verifie l'authentification Subsonic (md5 + sel) comme le vrai. */
export async function startMockNavidrome(): Promise<MockNav> {
  const downloads: Record<string, number> = {};
  const songMeta = (id: string) => ({ id, title: `Titre ${id}`, artist: 'Artiste', album: 'Album', albumId: 'al1', duration: 180, size: SONGS[id]!.length, suffix: 'mp3', coverArt: 'al-al1' });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = u.searchParams;
    const expected = createHash('md5').update(NAV_PASS + (q.get('s') ?? '')).digest('hex');
    const json = (obj: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...(obj as object) } })); };
    if (q.get('u') !== NAV_USER || q.get('t') !== expected) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } })); }
    const ep = u.pathname.replace('/rest/', '').replace('.view', '');
    const id = q.get('id') ?? '';
    switch (ep) {
      case 'ping': return json({});
      case 'getArtists': return json({ artists: { index: [{ name: 'A', artist: [{ id: 'ar1', name: 'Artiste', albumCount: 1 }] }] } });
      case 'getPlaylists': return json({ playlists: { playlist: [{ id: 'p1', name: 'Ma playlist', songCount: 3, duration: 540 }] } });
      case 'getPlaylist': return json({ playlist: { id: 'p1', name: 'Ma playlist', songCount: 3, duration: 540, entry: ['s1', 's2', 's3'].map(songMeta) } });
      case 'getSong': return json({ song: songMeta(id) });
      case 'search3': return json({ searchResult3: { song: ['s1'].map(songMeta) } });
      case 'getCoverArt': res.setHeader('content-type', 'image/png'); return res.end(Buffer.from([137, 80, 78, 71]));
      case 'download':
      case 'stream': {
        const data = SONGS[id];
        if (!data) { res.statusCode = 404; return res.end(); }
        if (ep === 'download') downloads[id] = (downloads[id] ?? 0) + 1;
        res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('accept-ranges', 'bytes');
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (m) {
          const start = Number(m[1] || 0); const end = m[2] ? Number(m[2]) : data.length - 1;
          res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`); res.setHeader('content-length', end - start + 1);
          return res.end(data.subarray(start, end + 1));
        }
        res.setHeader('content-length', data.length);
        return res.end(data);
      }
      default: return json({});
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, downloads, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export interface Harness { ctx: AppContext; nav: MockNav; base: string; wsBase: string; dir: string; stop: () => Promise<void> }

export async function startHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const nav = await startMockNavidrome();
  const dir = mkdtempSync(join(tmpdir(), 'nial-test-'));
  const config: Config = {
    env: 'test', host: '127.0.0.1', port: 0, publicUrl: 'https://nial.test', dataDir: dir, logLevel: 'silent', trustProxy: false,
    navidromeUrl: nav.url, navidromeUser: NAV_USER, navidromePassword: NAV_PASS, streamBaseUrl: 'http://stream.test', relayEnabled: true,
    allowedOrigins: [], streamSecrets: [STREAM_SECRET], rateLimitMultiplier: 100, ...overrides,
  };
  const ctx = await buildApp(config);
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (ctx.app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    ctx, nav, base, wsBase: `ws://127.0.0.1:${port}`, dir,
    stop: async () => { await ctx.app.close(); ctx.db.close(); await nav.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function api(h: Harness, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; headers: Headers; raw: Response }> {
  const res = await fetch(h.base + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await res.clone().json().catch(() => null) : null;
  return { status: res.status, body, headers: res.headers, raw: res };
}

export const PASSWORD = 'correct-horse-battery-staple';

export async function createAdmin(h: Harness, name = 'admin'): Promise<{ token: string; id: string }> {
  const u = await h.ctx.auth.createUser({ username: name, password: PASSWORD, role: 'admin' });
  const r = await api(h, 'POST', '/api/auth/login', { body: { identifier: name, password: PASSWORD } });
  return { token: r.body.accessToken as string, id: u.id };
}
export async function createUser(h: Harness, admin: string, name: string): Promise<{ token: string; id: string }> {
  const c = await api(h, 'POST', '/api/users', { token: admin, body: { username: name, password: PASSWORD, role: 'user' } });
  const r = await api(h, 'POST', '/api/auth/login', { body: { identifier: name, password: PASSWORD } });
  return { token: r.body.accessToken as string, id: c.body.id as string };
}

// ---------- faux telephone ----------
export class FakeDevice {
  deviceId = '';
  ws!: WebSocket;
  messages: any[] = [];
  serverPublicKey = '';
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
  readonly privateKey; readonly publicKeyB64: string;
  closed: { code: number; reason: string } | null = null;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  async pair(h: Harness, ownerToken: string, name = 'Telephone A', caps?: string[]): Promise<string> {
    const code = (await api(h, 'POST', '/api/pairing/codes', { token: ownerToken, body: { name, caps } })).body.code as string;
    const reg = await api(h, 'POST', '/api/pairing/register', { body: { code, publicKey: this.publicKeyB64, model: 'Pixel 7', os: 'Android 14' } });
    if (reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg.body));
    this.deviceId = reg.body.deviceId; this.serverPublicKey = reg.body.serverPublicKey;
    return this.deviceId;
  }

  sign(data: string): string { return nodeSign('sha256', Buffer.from(data), { key: this.privateKey, dsaEncoding: 'der' }).toString('base64'); }

  async connect(h: Harness, opts: { signWith?: (d: string) => string; ts?: number } = {}): Promise<void> {
    this.ws = new WebSocket(h.wsBase + '/ws/device');
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.messages.push(m);
      if (m.type === 'hello') {
        const ts = opts.ts ?? Date.now();
        const s = (opts.signWith ?? ((d) => this.sign(d)))(deviceAuthString(this.deviceId, m.nonce, ts));
        this.ws.send(JSON.stringify({ type: 'auth', deviceId: this.deviceId, ts, sig: s }));
      }
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
    });
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
  }

  waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting message; got ' + JSON.stringify(this.messages.map((m) => m.type)))), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  }
  async nextCommand(type?: string): Promise<CommandEnvelope> {
    const m = await this.waitFor((x) => x.type === 'command' && (!type || x.command.type === type) && !x._consumed);
    m._consumed = true;
    return m.command as CommandEnvelope;
  }
  waitClosed(ms = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('not closed')), ms); this.ws.once('close', (code, reason) => { clearTimeout(t); res({ code, reason: reason.toString() }); }); });
  }
  send(msg: object): void { this.ws.send(JSON.stringify(msg)); }
  close(): void { try { this.ws.close(); } catch { /* deja ferme */ } }
}

/** Verifie la signature Ed25519 d'une commande avec la cle publique du serveur (comme le fera le telephone). */
export function verifyEnvelope(env: CommandEnvelope, serverPublicKeyB64: string): boolean {
  const { sig, ...rest } = env;
  const key = createPublicKey({ key: Buffer.from(serverPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  return nodeVerify(null, Buffer.from(envelopeSigningString(rest, sha256Hex(env.payload))), key, Buffer.from(sig, 'base64'));
}

/** Les liens pointent vers http://stream.test : on les rejoue contre le serveur de test (mode relais). */
export const localPath = (url: string): string => new URL(url).pathname;
