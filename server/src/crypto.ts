import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Jeton opaque (256 bits). Seul son hash SHA-256 est stocke en base. */
export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const hashToken = (token: string): string => sha256Hex(token);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Code d'association lisible : 8 caracteres sans ambiguite (0/O, 1/I). */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// ---- Cle de signature du serveur (Ed25519) : signe les commandes envoyees aux appareils ----

export interface ServerKeys {
  publicKeyB64: string; // SPKI DER en base64
  sign(data: string): string; // signature base64
}

export function loadOrCreateServerKeys(dataDir: string): ServerKeys {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'server-signing.key');
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const privateKey = createPrivateKey(readFileSync(path));
  const publicKey = createPublicKey(privateKey);
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (data) => nodeSign(null, Buffer.from(data), privateKey).toString('base64'),
  };
}

// ---- Cle d'appareil (ECDSA P-256, generee dans Keystore / Secure Enclave) ----

export function isValidDevicePublicKey(spkiB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

export function verifyDeviceSignature(spkiB64: string, data: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return nodeVerify('sha256', Buffer.from(data), { key, dsaEncoding: 'der' }, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// ---- Liens de flux signes (HMAC-SHA256) ----

export interface LinkPayload {
  d: string; // identifiant d'appareil
  t: string; // identifiant de morceau ou de pochette
  k: 'stream' | 'download' | 'cover';
  e: number; // expiration, secondes epoch
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function signLink(payload: LinkPayload, secrets: string[]): string {
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac('sha256', secrets[0] as string).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

export function verifyLink(token: string, secrets: string[], now = Date.now()): LinkPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  if (body.length > 1024) return null;
  let ok = false;
  for (const secret of secrets) {
    const expected = b64u(createHmac('sha256', secret).update(body).digest());
    if (safeEqual(expected, mac)) ok = true; // pas de court-circuit : evite de distinguer les secrets
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload;
    if (typeof p.d !== 'string' || typeof p.t !== 'string' || typeof p.e !== 'number') return null;
    if (p.k !== 'stream' && p.k !== 'download' && p.k !== 'cover') return null;
    if (p.e * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}
