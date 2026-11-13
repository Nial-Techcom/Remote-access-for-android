/**
 * Passerelle de flux autonome. A deployer pres de Navidrome pour que les telephones recuperent
 * l'audio directement, sans passer par le serveur central. Aucune base de donnees : la validite d'un lien
 * repose sur sa signature et sa courte expiration.
 */
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'node:fs';
import { loadStreamSecrets } from './config.js';
import { NavidromeClient } from './navidrome.js';
import { registerStreamGateway } from './streams.js';

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`Variable manquante : ${k}`); return v; };
const password = env['NAVIDROME_PASSWORD_FILE'] ? readFileSync(env['NAVIDROME_PASSWORD_FILE'], 'utf8').trim() : need('NAVIDROME_PASSWORD');
if (!env['STREAM_SECRETS'] && !env['STREAM_SECRETS_FILE']) throw new Error('STREAM_SECRETS ou STREAM_SECRETS_FILE est obligatoire pour la passerelle (meme valeur que le serveur central)');

const secrets = loadStreamSecrets(env, env['DATA_DIR'] ?? '/var/lib/nial-gateway');
const app = Fastify({ logger: { level: env['LOG_LEVEL'] ?? 'info', redact: ['req.headers.authorization', 'req.url'] }, trustProxy: env['TRUST_PROXY'] === '1', routerOptions: { maxParamLength: 512 } });
await app.register(helmet);
await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
app.get('/api/health', async () => ({ status: 'ok' }));
registerStreamGateway(app, { navidrome: new NavidromeClient(need('NAVIDROME_URL'), need('NAVIDROME_USER'), password), secrets });
await app.listen({ host: env['HOST'] ?? '127.0.0.1', port: Number(env['PORT'] ?? 8081) });
