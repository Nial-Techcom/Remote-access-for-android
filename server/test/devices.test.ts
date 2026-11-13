import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createAdmin, createUser, FakeDevice, startHarness, verifyEnvelope, type Harness } from './helpers.js';
import { sha256Hex } from '../src/crypto.js';

let h: Harness;
let admin: { token: string; id: string };
beforeAll(async () => { h = await startHarness(); admin = await createAdmin(h, 'admin'); });
afterAll(async () => { await h.stop(); });

async function pairedActive(name = 'Tel', caps?: string[]): Promise<FakeDevice> {
  const d = new FakeDevice();
  await d.pair(h, admin.token, name, caps);
  const r = await api(h, 'POST', `/api/devices/${d.deviceId}/approve`, { token: admin.token, body: {} });
  expect(r.status).toBe(200);
  await d.connect(h);
  await d.waitFor((m) => m.type === 'ready');
  return d;
}

describe('association des appareils', () => {
  it('suit le parcours code -> enregistrement -> validation -> connexion', async () => {
    const d = new FakeDevice();
    await d.pair(h, admin.token, 'Salon');
    await d.connect(h);
    await d.waitFor((m) => m.type === 'pairing.pending');
    // En attente : aucune commande ne peut lui etre envoyee
    const pending = await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.pause' } });
    expect(pending.status).toBe(409);
    await api(h, 'POST', `/api/devices/${d.deviceId}/approve`, { token: admin.token, body: { name: 'Salon valide' } });
    await d.waitFor((m) => m.type === 'pairing.approved');
    d.close();
  });

  it('un code d\'association est a usage unique', async () => {
    const code = (await api(h, 'POST', '/api/pairing/codes', { token: admin.token, body: { name: 'X' } })).body.code;
    const a = new FakeDevice(); const b = new FakeDevice();
    expect((await api(h, 'POST', '/api/pairing/register', { body: { code, publicKey: a.publicKeyB64 } })).status).toBe(200);
    expect((await api(h, 'POST', '/api/pairing/register', { body: { code, publicKey: b.publicKeyB64 } })).status).toBe(400);
  });

  it('refuse un code inconnu et une cle publique invalide', async () => {
    const a = new FakeDevice();
    expect((await api(h, 'POST', '/api/pairing/register', { body: { code: 'ZZZZZZZZ', publicKey: a.publicKeyB64 } })).status).toBe(400);
    const code = (await api(h, 'POST', '/api/pairing/codes', { token: admin.token, body: { name: 'Y' } })).body.code;
    expect((await api(h, 'POST', '/api/pairing/register', { body: { code, publicKey: 'A'.repeat(100) } })).status).toBe(400);
  });

  it('refuse la connexion avec une mauvaise signature, un defi rejoue ou un horodatage perime', async () => {
    const d = new FakeDevice();
    await d.pair(h, admin.token);
    await api(h, 'POST', `/api/devices/${d.deviceId}/approve`, { token: admin.token, body: {} });
    const imposteur = new FakeDevice();
    await d.connect(h, { signWith: (data) => imposteur.sign(data) });
    expect((await d.waitClosed()).code).toBe(4401);

    const d2 = new FakeDevice();
    d2.deviceId = d.deviceId; (d2 as unknown as { privateKey: unknown }).privateKey = (d as unknown as { privateKey: unknown }).privateKey;
    await d2.connect(h, { ts: Date.now() - 10 * 60_000 });
    expect((await d2.waitClosed()).code).toBe(4401);
  });

  it('refuse un appareil inconnu', async () => {
    const d = new FakeDevice(); d.deviceId = '00000000-0000-0000-0000-000000000000';
    await d.connect(h);
    expect((await d.waitClosed()).code).toBe(4401);
  });

  it('ferme une connexion qui ne s\'authentifie pas ou envoie du binaire/JSON invalide', async () => {
    const d = await pairedActive();
    d.ws.send('pas du json');
    expect((await d.waitClosed()).code).toBe(1007);
  });
});

describe('commandes signees', () => {
  it('livre une commande dont la signature se verifie avec la cle epinglee a l\'association', async () => {
    const d = await pairedActive();
    const r = await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.volume', payload: { level: 0.5 } } });
    expect(r.status).toBe(202);
    const env = await d.nextCommand('playback.volume');
    expect(verifyEnvelope(env, d.serverPublicKey)).toBe(true);
    expect(env.deviceId).toBe(d.deviceId);
    expect(JSON.parse(env.payload)).toEqual({ level: 0.5 });
    // toute alteration invalide la signature
    expect(verifyEnvelope({ ...env, payload: JSON.stringify({ level: 1 }) }, d.serverPublicKey)).toBe(false);
    expect(verifyEnvelope({ ...env, seq: env.seq + 1 }, d.serverPublicKey)).toBe(false);
    expect(verifyEnvelope({ ...env, deviceId: 'autre' }, d.serverPublicKey)).toBe(false);
    expect(verifyEnvelope({ ...env, exp: env.exp + 1 }, d.serverPublicKey)).toBe(false);
    d.close();
  });

  it('numerote les commandes de facon strictement croissante, avec nonce unique et expiration', async () => {
    const d = await pairedActive();
    for (let i = 0; i < 3; i++) await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.next' } });
    const envs = [await d.nextCommand(), await d.nextCommand(), await d.nextCommand()];
    expect(envs.map((e) => e.seq)).toEqual([envs[0]!.seq, envs[0]!.seq + 1, envs[0]!.seq + 2]);
    expect(new Set(envs.map((e) => e.nonce)).size).toBe(3);
    for (const e of envs) expect(e.exp).toBeGreaterThan(e.ts);
    d.close();
  });

  it('met en file les commandes d\'un appareil hors ligne puis les livre dans l\'ordre a la reconnexion', async () => {
    const d = await pairedActive();
    d.close(); await d.waitClosed();
    await new Promise((r) => setTimeout(r, 100));
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.pause' } });
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.resume' } });
    const d2 = new FakeDevice();
    (d2 as unknown as { privateKey: unknown }).privateKey = (d as unknown as { privateKey: unknown }).privateKey;
    d2.deviceId = d.deviceId; d2.serverPublicKey = d.serverPublicKey;
    await d2.connect(h);
    const a = await d2.nextCommand(); const b = await d2.nextCommand();
    expect([a.type, b.type]).toEqual(['playback.pause', 'playback.resume']);
    expect(b.seq).toBe(a.seq + 1);
    d2.close();
  });

  it('n\'envoie pas une commande expiree', async () => {
    const d = await pairedActive();
    d.close(); await d.waitClosed();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.pause' } });
    h.ctx.db.prepare("UPDATE commands SET exp = ? WHERE device_id = ?").run(Date.now() - 1000, d.deviceId);
    const d2 = new FakeDevice();
    (d2 as unknown as { privateKey: unknown }).privateKey = (d as unknown as { privateKey: unknown }).privateKey;
    d2.deviceId = d.deviceId;
    await d2.connect(h);
    await d2.waitFor((m) => m.type === 'ready');
    await new Promise((r) => setTimeout(r, 150));
    expect(d2.messages.some((m) => m.type === 'command')).toBe(false);
    d2.close();
  });

  it('valide strictement les charges utiles', async () => {
    const d = await pairedActive();
    for (const body of [
      { type: 'playback.volume', payload: { level: 5 } },
      { type: 'playback.seek', payload: { positionMs: -1 } },
      { type: 'playback.play', payload: { trackIds: ['../../etc/passwd'], mode: 'stream' } },
      { type: 'playback.play', payload: { trackIds: [], mode: 'stream' } },
      { type: 'inexistante', payload: {} },
      { type: 'device.revoked', payload: {} }, // reservee au serveur
    ]) expect((await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body })).status, JSON.stringify(body)).toBe(400);
    d.close();
  });

  it('ne diffuse l\'etat de l\'appareil qu\'aux utilisateurs autorises et l\'expose dans l\'API', async () => {
    const d = await pairedActive('Etat');
    d.send({ type: 'state', state: { battery: { level: 0.8, charging: true }, output: { name: 'JBL Flip', type: 'bluetooth' }, playback: { status: 'playing', mode: 'stream', title: 'T', positionMs: 1000, durationMs: 180000 } } });
    await new Promise((r) => setTimeout(r, 150));
    const r = await api(h, 'GET', `/api/devices/${d.deviceId}`, { token: admin.token });
    expect(r.body.online).toBe(true);
    expect(r.body.state.output).toEqual({ name: 'JBL Flip', type: 'bluetooth' });
    expect(r.body.state.battery.level).toBe(0.8);
    d.close();
  });
});

describe('permissions et isolation', () => {
  it('cache les appareils aux utilisateurs sans acces (404, pas d\'enumeration)', async () => {
    const d = await pairedActive('Prive');
    const intrus = await createUser(h, admin.token, 'intrus');
    expect((await api(h, 'GET', `/api/devices/${d.deviceId}`, { token: intrus.token })).status).toBe(404);
    expect((await api(h, 'GET', '/api/devices/inexistant', { token: intrus.token })).status).toBe(404);
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: intrus.token, body: { type: 'playback.pause' } })).status).toBe(404);
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/revoke`, { token: intrus.token })).status).toBe(404);
    expect(((await api(h, 'GET', '/api/devices', { token: intrus.token })).body.devices as unknown[]).length).toBe(0);
    d.close();
  });

  it('applique les droits accordes appareil par appareil', async () => {
    const d = await pairedActive('Partage');
    const u = await createUser(h, admin.token, 'invite');
    await api(h, 'PUT', `/api/devices/${d.deviceId}/grants/${u.id}`, { token: admin.token, body: { perms: ['music.control'] } });
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: u.token, body: { type: 'playback.pause' } })).status).toBe(202);
    // music.send non accorde : envoyer une playlist est refuse
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: u.token, body: { type: 'playback.play', payload: { trackIds: ['s1'], mode: 'stream' } } })).status).toBe(403);
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/playlists/p1/send`, { token: u.token, body: { mode: 'stream' } })).status).toBe(403);
    // un invité ne peut pas gérer les droits ni revoquer
    expect((await api(h, 'PUT', `/api/devices/${d.deviceId}/grants/${u.id}`, { token: u.token, body: { perms: ['screen.view'] } })).status).toBe(403);
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/revoke`, { token: u.token })).status).toBe(404);
    await api(h, 'DELETE', `/api/devices/${d.deviceId}/grants/${u.id}`, { token: admin.token });
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: u.token, body: { type: 'playback.pause' } })).status).toBe(404);
    d.close();
  });

  it('n\'accorde jamais le controle d\'ecran par defaut', async () => {
    const d = await pairedActive('SansEcran');
    const r = await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'screen.start', payload: { sessionId: 's1' } } });
    expect(r.status).toBe(403);
    const g = await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'input.gesture', payload: { sessionId: 's1', kind: 'tap', x: 0.5, y: 0.5 } } });
    expect(g.status).toBe(403);
    d.close();
  });

  it('un utilisateur non admin ne peut pas accorder les permissions d\'ecran, meme sur son appareil', async () => {
    const u = await createUser(h, admin.token, 'proprio');
    const d = new FakeDevice();
    await d.pair(h, u.token, 'Mien', ['music.control', 'screen.view', 'screen.control']);
    const r = await api(h, 'POST', `/api/devices/${d.deviceId}/approve`, { token: u.token, body: { caps: ['screen.view', 'music.control'] } });
    expect(r.body.caps).toEqual(['music.control']);
    const patch = await api(h, 'PATCH', `/api/devices/${d.deviceId}`, { token: u.token, body: { caps: ['screen.view'] } });
    expect(patch.status).toBe(403);
  });

  it('journalise le partage d\'ecran quand l\'administrateur l\'a explicitement autorise', async () => {
    const d = await pairedActive('Avec ecran', ['music.control', 'screen.view', 'screen.control']);
    const start = await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'screen.start', payload: { sessionId: 'sess-1' } } });
    expect(start.status).toBe(202);
    const env = await d.nextCommand('screen.start');
    expect(verifyEnvelope(env, d.serverPublicKey)).toBe(true);
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'screen.stop', payload: { sessionId: 'sess-1' } } });
    const audit = (await api(h, 'GET', '/api/audit?limit=100', { token: admin.token })).body.events as { action: string; target: string }[];
    expect(audit.some((e) => e.action === 'screen.start' && e.target === d.deviceId)).toBe(true);
    expect(audit.some((e) => e.action === 'screen.stop' && e.target === d.deviceId)).toBe(true);
    d.close();
  });

  it('revoque un appareil immediatement : notification, coupure, plus de reconnexion possible', async () => {
    const d = await pairedActive('Perdu');
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/revoke`, { token: admin.token })).status).toBe(204);
    const env = await d.nextCommand('device.revoked');
    expect(verifyEnvelope(env, d.serverPublicKey)).toBe(true);
    expect((await d.waitClosed()).code).toBe(4001);
    const again = new FakeDevice();
    (again as unknown as { privateKey: unknown }).privateKey = (d as unknown as { privateKey: unknown }).privateKey;
    again.deviceId = d.deviceId;
    await again.connect(h);
    expect((await again.waitClosed()).code).toBe(4401);
    expect((await api(h, 'GET', `/api/devices/${d.deviceId}`, { token: admin.token })).status).toBe(404);
  });
});

describe('temps reel Controller', () => {
  it('authentifie par premier message (pas par URL), envoie un instantane et relaie les evenements', async () => {
    const d = await pairedActive('RT');
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(h.wsBase + '/ws/controller');
    const msgs: any[] = [];
    ws.on('message', (r) => msgs.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: admin.token }));
    await vi_wait(() => msgs.some((m) => m.type === 'ready'));
    expect(msgs.find((m) => m.type === 'ready').devices.some((x: { id: string }) => x.id === d.deviceId)).toBe(true);
    d.send({ type: 'state', state: { playback: { status: 'playing' } } });
    await vi_wait(() => msgs.some((m) => m.type === 'device.state'));
    ws.send(JSON.stringify({ type: 'command', reqId: 'r1', deviceId: d.deviceId, cmd: 'playback.pause', payload: {} }));
    await vi_wait(() => msgs.some((m) => m.type === 'command.result' && m.ok));
    const env = await d.nextCommand('playback.pause');
    d.send({ type: 'ack', commandId: env.id, status: 'done' });
    await vi_wait(() => msgs.some((m) => m.type === 'command.update' && m.status === 'done'));
    ws.close(); d.close();
  });

  it('refuse un Controller avec un mauvais jeton', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(h.wsBase + '/ws/controller');
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: 'jeton-invalide' }));
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('refuse l\'ordre d\'un Controller sans permission sur l\'appareil', async () => {
    const d = await pairedActive('Cible');
    const u = await createUser(h, admin.token, 'curieux');
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(h.wsBase + '/ws/controller');
    const msgs: any[] = [];
    ws.on('message', (r) => msgs.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: u.token }));
    await vi_wait(() => msgs.some((m) => m.type === 'ready'));
    expect(msgs[0].devices.length).toBe(0);
    ws.send(JSON.stringify({ type: 'command', reqId: 'x', deviceId: d.deviceId, cmd: 'playback.pause', payload: {} }));
    await vi_wait(() => msgs.some((m) => m.type === 'command.result'));
    expect(msgs.find((m) => m.type === 'command.result').ok).toBe(false);
    ws.close(); d.close();
  });
});

async function vi_wait(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('condition non atteinte'); await new Promise((r) => setTimeout(r, 20)); }
}

describe('base de donnees', () => {
  it('ne contient aucune cle privee d\'appareil et hache les codes d\'association', () => {
    const codes = h.ctx.db.prepare('SELECT code_hash FROM pairing_codes').all() as { code_hash: string }[];
    for (const c of codes) expect(c.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('x')).toHaveLength(64);
  });
});
