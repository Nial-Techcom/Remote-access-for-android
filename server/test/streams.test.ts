import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { api, createAdmin, FakeDevice, localPath, NAV_PASS, NAV_USER, SONGS, startHarness, STREAM_SECRET, type Harness } from './helpers.js';
import { signLink, verifyLink } from '../src/crypto.js';

let h: Harness;
let admin: { token: string; id: string };
beforeAll(async () => { h = await startHarness(); admin = await createAdmin(h, 'admin'); });
afterAll(async () => { await h.stop(); });

async function activeDevice(): Promise<FakeDevice> {
  const d = new FakeDevice();
  await d.pair(h, admin.token, 'Tel');
  await api(h, 'POST', `/api/devices/${d.deviceId}/approve`, { token: admin.token, body: {} });
  await d.connect(h);
  await d.waitFor((m) => m.type === 'ready');
  return d;
}
const requestLinks = async (d: FakeDevice, kind: string, ids: string[]) => {
  const reqId = Math.random().toString(36).slice(2);
  d.send({ type: 'links.request', reqId, kind, ids });
  return (await d.waitFor((m) => m.type === 'links.response' && m.reqId === reqId)).links as Record<string, { url: string; expiresAt: number } | null>;
};

describe('liens signes (unitaire)', () => {
  const secrets = ['a'.repeat(40), 'b'.repeat(40)];
  const now = Date.now();
  const payload = { d: 'dev', t: 's1', k: 'stream' as const, e: Math.floor(now / 1000) + 60 };
  it('accepte un lien valide, refuse expire, altere, mauvais secret, mauvais format', () => {
    const tok = signLink(payload, secrets);
    expect(verifyLink(tok, secrets, now)?.t).toBe('s1');
    expect(verifyLink(tok, secrets, now + 120_000)).toBeNull();
    const [body, mac] = tok.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, t: 's2' })).toString('base64url');
    expect(verifyLink(`${forged}.${mac}`, secrets, now)).toBeNull();
    expect(verifyLink(`${body}.${mac.slice(0, -2)}xx`, secrets, now)).toBeNull();
    expect(verifyLink(tok, ['c'.repeat(40)], now)).toBeNull();
    expect(verifyLink('nimportequoi', secrets, now)).toBeNull();
    expect(verifyLink('a.b.c', secrets, now)).toBeNull();
  });
  it('supporte la rotation : un ancien secret reste valide en verification', () => {
    const old = signLink(payload, ['b'.repeat(40)]);
    expect(verifyLink(old, secrets, now)).not.toBeNull();
  });
});

describe('streaming direct / relais', () => {
  it('envoie l\'audio avec un lien signe et gere les requetes Range (reprise)', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.play', payload: { trackIds: ['s1'], mode: 'stream' } } });
    const links = await requestLinks(d, 'stream', ['s1']);
    const url = localPath(links['s1']!.url);
    const full = await fetch(h.base + url);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer()).equals(SONGS['s1']!)).toBe(true);
    const part = await fetch(h.base + url, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(SONGS['s1']!.subarray(10, 20))).toBe(true);
    expect(full.headers.get('cache-control')).toContain('no-store');
    d.close();
  });

  it('refuse un lien altere, expire ou sans signature', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.play', payload: { trackIds: ['s1'], mode: 'stream' } } });
    const url = localPath((await requestLinks(d, 'stream', ['s1']))['s1']!.url);
    expect((await fetch(h.base + url.slice(0, -3) + 'AAA')).status).toBe(403);
    expect((await fetch(h.base + '/s/abc')).status).toBe(403);
    const expired = signLink({ d: d.deviceId, t: 's1', k: 'stream', e: Math.floor(Date.now() / 1000) - 5 }, [STREAM_SECRET]);
    expect((await fetch(`${h.base}/s/${expired}`)).status).toBe(403);
    d.close();
  });

  it('ne donne un lien de flux que pour les pistes envoyees a cet appareil', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.play', payload: { trackIds: ['s1'], mode: 'stream' } } });
    const links = await requestLinks(d, 'stream', ['s1', 's2']);
    expect(links['s1']).not.toBeNull();
    expect(links['s2']).toBeNull();
    d.close();
  });

  it('coupe l\'acces d\'un appareil revoque meme avec un lien encore valide', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.play', payload: { trackIds: ['s3'], mode: 'stream' } } });
    const url = localPath((await requestLinks(d, 'stream', ['s3']))['s3']!.url);
    expect((await fetch(h.base + url)).status).toBe(200);
    await api(h, 'POST', `/api/devices/${d.deviceId}/revoke`, { token: admin.token });
    expect((await fetch(h.base + url)).status).toBe(403);
  });

  it('ne laisse pas un identifiant malveillant atteindre Navidrome', async () => {
    const evil = signLink({ d: 'x', t: 's1&u=admin&p=x', k: 'stream', e: Math.floor(Date.now() / 1000) + 60 }, [STREAM_SECRET]);
    expect((await fetch(`${h.base}/s/${evil}`)).status).toBe(403);
    const traversal = signLink({ d: 'x', t: '../rest/getUsers', k: 'stream', e: Math.floor(Date.now() / 1000) + 60 }, [STREAM_SECRET]);
    expect((await fetch(`${h.base}/s/${traversal}`)).status).toBe(403);
  });
});

describe('identifiants Navidrome', () => {
  it('ne fuient dans aucune reponse API, lien, message temps reel ni journal', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/commands`, { token: admin.token, body: { type: 'playback.play', payload: { trackIds: ['s1'], mode: 'stream' } } });
    const link = (await requestLinks(d, 'stream', ['s1']))['s1']!.url;
    const md5 = createHash('md5').update(NAV_PASS).digest('hex');
    const responses = [
      await api(h, 'GET', '/api/library/playlists', { token: admin.token }),
      await api(h, 'GET', '/api/library/playlists/p1', { token: admin.token }),
      await api(h, 'GET', '/api/library/artists', { token: admin.token }),
      await api(h, 'GET', '/api/library/search?q=titre', { token: admin.token }),
      await api(h, 'GET', '/api/status', { token: admin.token }),
      await api(h, 'GET', '/api/audit?limit=500', { token: admin.token }),
    ];
    const blob = JSON.stringify(responses.map((r) => r.body)) + link + JSON.stringify(d.messages);
    for (const secret of [NAV_PASS, NAV_USER, md5, STREAM_SECRET]) expect(blob).not.toContain(secret);
    expect(link).not.toMatch(/[?&](u|t|s|p)=/);
    d.close();
  });

  it('renvoie la bibliotheque sous forme de DTO sans champ interne', async () => {
    const pl = await api(h, 'GET', '/api/library/playlists/p1', { token: admin.token });
    expect(pl.body.songs).toHaveLength(3);
    expect(Object.keys(pl.body.songs[0]).sort()).toEqual(['album', 'albumId', 'artist', 'coverId', 'durationSec', 'id', 'size', 'suffix', 'title', 'track'].filter((k) => k in pl.body.songs[0]).sort());
    const cover = await api(h, 'GET', '/api/library/cover/al-al1?size=100', { token: admin.token });
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect((await api(h, 'GET', '/api/library/cover/..%2F..%2Fetc', { token: admin.token })).status).toBe(400);
    expect((await api(h, 'GET', '/api/library/cover/al-al1')).status).toBe(401);
  });
});

describe('envoi de playlists', () => {
  it('mode streaming : envoie la liste de pistes a l\'appareil', async () => {
    const d = await activeDevice();
    const r = await api(h, 'POST', `/api/devices/${d.deviceId}/playlists/p1/send`, { token: admin.token, body: { mode: 'stream' } });
    expect(r.status).toBe(202);
    const env = await d.nextCommand('playback.play');
    expect(JSON.parse(env.payload).trackIds).toEqual(['s1', 's2', 's3']);
    d.close();
  });

  it('mode telechargement : manifeste avec SHA-256 exacts, sans retelecharger ce qui est en cache', async () => {
    const d = await activeDevice();
    const before = { ...h.nav.downloads };
    const r = await api(h, 'POST', `/api/devices/${d.deviceId}/playlists/p1/send`, { token: admin.token, body: { mode: 'download' } });
    expect(r.body.status).toBe('preparing');
    const env = await d.nextCommand('download.manifest');
    const man = JSON.parse(env.payload) as { tracks: { id: string; sha256: string; size: number }[] };
    expect(man.tracks).toHaveLength(3);
    for (const t of man.tracks) {
      expect(t.sha256).toBe(createHash('sha256').update(SONGS[t.id]!).digest('hex'));
      expect(t.size).toBe(SONGS[t.id]!.length);
    }
    // second envoi vers un autre telephone : empreintes en cache, aucun nouveau telechargement cote Navidrome
    const afterFirst = { ...h.nav.downloads };
    const d2 = await activeDevice();
    await api(h, 'POST', `/api/devices/${d2.deviceId}/playlists/p1/send`, { token: admin.token, body: { mode: 'download' } });
    await d2.nextCommand('download.manifest');
    expect(h.nav.downloads).toEqual(afterFirst);
    expect(Object.values(afterFirst).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(Object.values(before).reduce((a, b) => a + b, 0));
    // les pistes du manifeste sont ensuite telechargeables via liens signes, sans transcodage (octets identiques)
    const links = await requestLinks(d, 'download', ['s2']);
    const got = Buffer.from(await (await fetch(h.base + localPath(links['s2']!.url))).arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(man.tracks.find((t) => t.id === 's2')!.sha256);
    d.close(); d2.close();
  });

  it('mode hybride : manifeste puis lecture en mode hybride', async () => {
    const d = await activeDevice();
    await api(h, 'POST', `/api/devices/${d.deviceId}/playlists/p1/send`, { token: admin.token, body: { mode: 'hybrid', play: true } });
    await d.nextCommand('download.manifest');
    const play = await d.nextCommand('playback.play');
    expect(JSON.parse(play.payload).mode).toBe('hybrid');
    d.close();
  });

  it('refuse le telechargement vers un appareil hors ligne et les identifiants invalides', async () => {
    const d = await activeDevice();
    d.close(); await d.waitClosed(); await new Promise((r) => setTimeout(r, 100));
    expect((await api(h, 'POST', `/api/devices/${d.deviceId}/playlists/p1/send`, { token: admin.token, body: { mode: 'download' } })).status).toBe(409);
    const d2 = await activeDevice();
    expect((await api(h, 'POST', `/api/devices/${d2.deviceId}/playlists/..%2Fx/send`, { token: admin.token, body: { mode: 'stream' } })).status).toBe(400);
    d2.close();
  });
});
