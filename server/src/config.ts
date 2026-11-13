import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

const bool = z
  .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
  .default('0')
  .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.string().url(),
  DATA_DIR: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool,
  NAVIDROME_URL: z.string().url(),
  NAVIDROME_USER: z.string().min(1),
  NAVIDROME_PASSWORD: z.string().min(1),
  STREAM_BASE_URL: z.string().url().optional(),
  RELAY_ENABLED: bool,
  ALLOWED_ORIGINS: z.string().default(''),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  logLevel: string;
  trustProxy: boolean;
  navidromeUrl: string;
  navidromeUser: string;
  navidromePassword: string;
  streamBaseUrl: string;
  relayEnabled: boolean;
  allowedOrigins: string[];
  streamSecrets: string[];
  /** Multiplicateur des limites de debit : honore UNIQUEMENT quand NODE_ENV=test. */
  rateLimitMultiplier: number;
}

/** Lit VAR ou VAR_FILE (fichier en lecture seule recommande pour les secrets). */
function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name];
}

export function loadStreamSecrets(env: NodeJS.ProcessEnv, dataDir: string): string[] {
  const explicit = readSecretEnv(env, 'STREAM_SECRETS');
  const raw = explicit?.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (raw && raw.length > 0) {
    for (const s of raw) if (s.length < 32) throw new Error('STREAM_SECRETS : chaque secret doit faire au moins 32 caracteres');
    return raw;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'stream-secrets');
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(48).toString('base64url') + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const withSecrets = { ...env, NAVIDROME_PASSWORD: readSecretEnv(env, 'NAVIDROME_PASSWORD') };
  const parsed = schema.safeParse(withSecrets);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuration invalide : ${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && !c.PUBLIC_URL.startsWith('https://')) {
    throw new Error('Configuration invalide : PUBLIC_URL doit etre en https en production');
  }
  if (!c.RELAY_ENABLED && !c.STREAM_BASE_URL) {
    throw new Error('Configuration invalide : definir STREAM_BASE_URL (passerelle de flux separee) ou RELAY_ENABLED=1 (relais par le serveur central)');
  }
  return {
    env: c.NODE_ENV,
    host: c.HOST,
    port: c.PORT,
    publicUrl: c.PUBLIC_URL.replace(/\/$/, ''),
    dataDir: c.DATA_DIR,
    logLevel: c.LOG_LEVEL,
    trustProxy: c.TRUST_PROXY,
    navidromeUrl: c.NAVIDROME_URL.replace(/\/$/, ''),
    navidromeUser: c.NAVIDROME_USER,
    navidromePassword: c.NAVIDROME_PASSWORD,
    streamBaseUrl: (c.STREAM_BASE_URL ?? c.PUBLIC_URL).replace(/\/$/, ''),
    relayEnabled: c.RELAY_ENABLED,
    allowedOrigins: c.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    streamSecrets: loadStreamSecrets(env, c.DATA_DIR),
    rateLimitMultiplier: 1,
  };
}
