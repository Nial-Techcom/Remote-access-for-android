import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createAdmin, createUser, PASSWORD, startHarness, type Harness } from './helpers.js';
import { validatePassword } from '../src/auth.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.stop(); });

describe('authentification', () => {
  it('refuse les routes protegees sans jeton', async () => {
    for (const [m, p] of [['GET', '/api/devices'], ['GET', '/api/users'], ['GET', '/api/library/playlists'], ['GET', '/api/audit'], ['GET', '/api/status']] as const) {
      expect((await api(h, m, p)).status).toBe(401);
    }
  });

  it('connecte un utilisateur et donne la meme reponse pour compte inconnu et mauvais mot de passe', async () => {
    await createAdmin(h, 'alice');
    const bad = await api(h, 'POST', '/api/auth/login', { body: { identifier: 'alice', password: 'mauvais-mot-de-passe' } });
    const unknown = await api(h, 'POST', '/api/auth/login', { body: { identifier: 'nobody', password: 'mauvais-mot-de-passe' } });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body).toEqual(unknown.body);
  });

  it('verrouille le compte apres des echecs repetes, sans le signaler', async () => {
    await createAdmin(h, 'bob');
    for (let i = 0; i < 5; i++) await api(h, 'POST', '/api/auth/login', { body: { identifier: 'bob', password: 'faux-faux-faux-faux' } });
    const r = await api(h, 'POST', '/api/auth/login', { body: { identifier: 'bob', password: PASSWORD } });
    expect(r.status).toBe(401); // meme avec le bon mot de passe, pendant le verrouillage
    expect(r.body.accessToken).toBeUndefined();
  });

  it('applique le politique de mot de passe', () => {
    expect(validatePassword('court', 'x')).not.toBeNull();
    expect(validatePassword('motdepasse12', 'x')).not.toBeNull();
    expect(validatePassword('jean-dupont-2024-secret', 'jean-dupont')).not.toBeNull();
    expect(validatePassword('une-phrase-de-passe-solide', 'x')).toBeNull();
  });

  it('fait tourner le jeton de rafraichissement et detecte sa reutilisation', async () => {
    await createAdmin(h, 'carol');
    const login = await api(h, 'POST', '/api/auth/login', { body: { identifier: 'carol', password: PASSWORD } });
    const r1 = await api(h, 'POST', '/api/auth/refresh', { body: { refreshToken: login.body.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // Rejeu de l'ancien jeton : refuse ET toute la session est revoquee
    const replay = await api(h, 'POST', '/api/auth/refresh', { body: { refreshToken: login.body.refreshToken } });
    expect(replay.status).toBe(401);
    expect((await api(h, 'GET', '/api/auth/me', { token: r1.body.accessToken })).status).toBe(401);
    expect((await api(h, 'POST', '/api/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);
  });

  it('revoque la session a la deconnexion', async () => {
    const a = await createAdmin(h, 'dave');
    expect((await api(h, 'GET', '/api/auth/me', { token: a.token })).status).toBe(200);
    expect((await api(h, 'POST', '/api/auth/logout', { token: a.token })).status).toBe(204);
    expect((await api(h, 'GET', '/api/auth/me', { token: a.token })).status).toBe(401);
  });

  it('refuse la gestion des utilisateurs a un simple utilisateur', async () => {
    const admin = await createAdmin(h, 'root');
    const u = await createUser(h, admin.token, 'simple');
    expect((await api(h, 'GET', '/api/users', { token: u.token })).status).toBe(403);
    expect((await api(h, 'POST', '/api/users', { token: u.token, body: { username: 'x-user', password: PASSWORD } })).status).toBe(403);
    expect((await api(h, 'GET', '/api/audit', { token: u.token })).status).toBe(403);
  });

  it('empeche de supprimer ou retrograder le dernier administrateur', async () => {
    const solo = await startHarness();
    try {
      const a = await createAdmin(solo, 'seul');
      expect((await api(solo, 'DELETE', `/api/users/${a.id}`, { token: a.token })).status).toBe(409);
      expect((await api(solo, 'PATCH', `/api/users/${a.id}`, { token: a.token, body: { role: 'user' } })).status).toBe(409);
    } finally { await solo.stop(); }
  });

  it('reinitialise un mot de passe avec un jeton a usage unique et coupe les sessions', async () => {
    const admin = await createAdmin(h, 'boss');
    const u = await createUser(h, admin.token, 'oublieux');
    const t = await api(h, 'POST', `/api/users/${u.id}/reset-token`, { token: admin.token });
    const nouveau = 'nouveau-mot-de-passe-solide';
    expect((await api(h, 'POST', '/api/auth/reset', { body: { token: t.body.token, newPassword: nouveau } })).status).toBe(204);
    expect((await api(h, 'POST', '/api/auth/reset', { body: { token: t.body.token, newPassword: nouveau + '2' } })).status).toBe(400);
    expect((await api(h, 'GET', '/api/auth/me', { token: u.token })).status).toBe(401);
    expect((await api(h, 'POST', '/api/auth/login', { body: { identifier: 'oublieux', password: nouveau } })).status).toBe(200);
  });

  it('ne stocke ni mot de passe ni jeton en clair', async () => {
    const rows = h.ctx.db.prepare('SELECT password_hash FROM users').all() as { password_hash: string }[];
    for (const r of rows) expect(r.password_hash.startsWith('$argon2id$')).toBe(true);
    const s = h.ctx.db.prepare('SELECT access_hash, refresh_hash FROM sessions LIMIT 1').get() as { access_hash: string; refresh_hash: string };
    expect(s.access_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('envoie des en-tetes de securite', async () => {
    const r = await api(h, 'GET', '/api/health');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });
});
