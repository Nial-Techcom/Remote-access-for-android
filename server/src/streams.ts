import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { signLink, verifyLink } from './crypto.js';
import { isValidId, NavidromeClient } from './navidrome.js';

export const LINK_TTL_SEC = { stream: 600, download: 1800, cover: 3600 } as const;

export class LinkService {
  constructor(private readonly secrets: string[], private readonly baseUrl: string) {}

  make(deviceId: string, kind: 'stream' | 'download' | 'cover', id: string, now = Date.now()): { url: string; expiresAt: number } {
    const e = Math.floor(now / 1000) + LINK_TTL_SEC[kind];
    return { url: `${this.baseUrl}/s/${signLink({ d: deviceId, t: id, k: kind, e }, this.secrets)}`, expiresAt: e * 1000 };
  }
}

export interface GatewayOptions {
  navidrome: NavidromeClient;
  secrets: string[];
  /** Verification facultative (mode relais dans le serveur central) : appareil toujours actif ? */
  isDeviceActive?: (deviceId: string) => boolean;
  onTransfer?: (info: { deviceId: string; kind: string; id: string; status: number }) => void;
  maxConcurrentPerDevice?: number;
}

/**
 * Passerelle de flux : verifie le lien signe, puis relaie la requete vers Navidrome avec UNIQUEMENT
 * l'identifiant du morceau (aucun parametre fourni par le client n'atteint Navidrome, sauf Range et size).
 * Peut etre montee dans le serveur central (relais) ou lancee seule pres de Navidrome (flux direct).
 */
export function registerStreamGateway(app: FastifyInstance, opts: GatewayOptions): void {
  const active = new Map<string, number>();
  const maxPerDevice = opts.maxConcurrentPerDevice ?? 4;

  app.get('/s/:token', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.params as { token: string }).token;
    const p = verifyLink(token, opts.secrets);
    if (!p || !isValidId(p.t)) return reply.code(403).send({ error: 'Lien invalide ou expire' });
    if (opts.isDeviceActive && !opts.isDeviceActive(p.d)) return reply.code(403).send({ error: 'Appareil non autorise' });

    const n = active.get(p.d) ?? 0;
    if (n >= maxPerDevice) return reply.code(429).send({ error: 'Trop de transferts simultanes' });

    const endpoint = p.k === 'stream' ? 'stream' : p.k === 'download' ? 'download' : 'getCoverArt';
    const extra: Record<string, string> = {};
    if (p.k === 'cover') {
      const size = Number((req.query as { size?: string }).size ?? 300);
      extra['size'] = String(Math.min(Math.max(Number.isFinite(size) ? Math.trunc(size) : 300, 32), 1200));
    }
    if (p.k === 'stream') extra['estimateContentLength'] = 'true';
    const url = opts.navidrome.upstreamUrl(endpoint, p.t, extra);
    const headers: Record<string, string> = {};
    const range = req.headers['range'];
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers['range'] = range;

    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    let up: Response;
    try {
      up = await opts.navidrome.fetchRaw(url, { headers, signal: controller.signal });
    } catch {
      return reply.code(502).send({ error: 'Source musicale injoignable' });
    }
    opts.onTransfer?.({ deviceId: p.d, kind: p.k, id: p.t, status: up.status });
    if (!up.ok && up.status !== 206) return reply.code(up.status === 404 ? 404 : 502).send({ error: 'Source musicale : erreur' });
    // Navidrome renvoie parfois une erreur Subsonic en JSON avec statut 200 : on ne la relaie jamais.
    const ct = up.headers.get('content-type') ?? 'application/octet-stream';
    if (ct.includes('json') || ct.includes('xml')) return reply.code(502).send({ error: 'Source musicale : reponse inattendue' });

    reply.code(up.status);
    reply.header('content-type', ct);
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = up.headers.get(h);
      if (v) reply.header(h, v);
    }
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (!up.body) return reply.send();
    active.set(p.d, n + 1);
    const stream = Readable.fromWeb(up.body as never);
    let finished = false;
    const done = () => {
      if (finished) return; // 'error' puis 'close' : ne decrementer qu'une fois
      finished = true;
      const c = active.get(p.d) ?? 1;
      if (c <= 1) active.delete(p.d); else active.set(p.d, c - 1);
    };
    stream.once('close', done);
    stream.once('error', done);
    return reply.send(stream);
  });
}
