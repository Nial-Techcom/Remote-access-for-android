import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const PERMISSIONS = ['music.control', 'music.send', 'device.status', 'screen.view', 'screen.control', 'files.manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Permissions accordees par defaut a un nouvel appareil. screen.* n'est jamais accorde par defaut. */
export const DEFAULT_CAPS: Permission[] = ['music.control', 'music.send', 'device.status'];

export const permissionSchema = z.enum(PERMISSIONS);

const trackId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const playbackModeSchema = z.enum(['stream', 'download', 'hybrid']);

/** Commandes Controller -> appareil et permission requise. */
export const COMMANDS = {
  'playback.play': { perm: 'music.send', ttlMs: 30_000, payload: z.object({ playlistId: z.string().max(64).optional(), trackIds: z.array(trackId).min(1).max(2000), startIndex: z.number().int().min(0).default(0), mode: playbackModeSchema }) },
  'playback.pause': { perm: 'music.control', ttlMs: 30_000, payload: z.object({}) },
  'playback.resume': { perm: 'music.control', ttlMs: 30_000, payload: z.object({}) },
  'playback.next': { perm: 'music.control', ttlMs: 30_000, payload: z.object({}) },
  'playback.prev': { perm: 'music.control', ttlMs: 30_000, payload: z.object({}) },
  'playback.seek': { perm: 'music.control', ttlMs: 30_000, payload: z.object({ positionMs: z.number().int().min(0) }) },
  'playback.volume': { perm: 'music.control', ttlMs: 30_000, payload: z.object({ level: z.number().min(0).max(1) }) },
  'playback.mode': { perm: 'music.control', ttlMs: 30_000, payload: z.object({ mode: playbackModeSchema }) },
  'download.manifest': { perm: 'music.send', ttlMs: 15 * 60_000, payload: z.object({ playlistId: z.string().max(64), tracks: z.array(z.object({ id: trackId, size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/), suffix: z.string().max(10), title: z.string().max(300), artist: z.string().max(300), album: z.string().max(300), durationSec: z.number().int().min(0), coverId: z.string().max(64).optional() })).max(5000), autoplay: z.boolean().default(false) }) },
  'download.purge': { perm: 'files.manage', ttlMs: 60_000, payload: z.object({ playlistId: z.string().max(64).optional() }) },
  'screen.start': { perm: 'screen.view', ttlMs: 30_000, payload: z.object({ sessionId: z.string().max(64) }) },
  'screen.stop': { perm: 'screen.view', ttlMs: 30_000, payload: z.object({ sessionId: z.string().max(64) }) },
  'screen.signal': { perm: 'screen.view', ttlMs: 30_000, payload: z.object({ sessionId: z.string().max(64), kind: z.enum(['offer', 'answer', 'ice']), data: z.string().max(20_000) }) },
  'input.gesture': { perm: 'screen.control', ttlMs: 10_000, payload: z.object({ sessionId: z.string().max(64), kind: z.enum(['tap', 'swipe', 'back', 'home', 'recents']), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), x2: z.number().min(0).max(1).optional(), y2: z.number().min(0).max(1).optional(), durationMs: z.number().int().min(1).max(5000).optional() }) },
  'device.revoked': { perm: 'device.status', ttlMs: 60_000, payload: z.object({}) },
} as const;

export type CommandType = keyof typeof COMMANDS;
export const isCommandType = (t: string): t is CommandType => Object.prototype.hasOwnProperty.call(COMMANDS, t);

/** Enveloppe signee par le serveur (Ed25519). `payload` est une chaine JSON : la signature couvre son SHA-256 exact. */
export interface CommandEnvelope {
  v: number;
  id: string;
  type: CommandType;
  deviceId: string;
  ts: number;
  exp: number;
  seq: number;
  nonce: string;
  payload: string;
  sig: string;
}

export const envelopeSigningString = (e: Omit<CommandEnvelope, 'sig'>, payloadSha256Hex: string): string =>
  ['nial-cmd', e.v, e.id, e.type, e.deviceId, e.ts, e.exp, e.seq, e.nonce, payloadSha256Hex].join('|');

export const deviceAuthString = (deviceId: string, nonce: string, ts: number): string => `nial-auth|1|${deviceId}|${nonce}|${ts}`;

// ---- Messages appareil -> serveur ----
export const deviceStateSchema = z.object({
  battery: z.object({ level: z.number().min(0).max(1), charging: z.boolean() }).optional(),
  network: z.object({ type: z.enum(['wifi', 'cellular', 'ethernet', 'none', 'other']), }).optional(),
  playback: z.object({
    status: z.enum(['idle', 'playing', 'paused', 'buffering', 'error']),
    mode: playbackModeSchema.optional(),
    playlistId: z.string().max(64).optional(),
    trackId: z.string().max(64).optional(),
    title: z.string().max(300).optional(),
    artist: z.string().max(300).optional(),
    album: z.string().max(300).optional(),
    coverId: z.string().max(64).optional(),
    positionMs: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
    volume: z.number().min(0).max(1).optional(),
    source: z.enum(['stream', 'local']).optional(),
  }).optional(),
  output: z.object({ name: z.string().max(100), type: z.enum(['speaker', 'bluetooth', 'wired', 'other']), }).optional(),
  storage: z.object({ freeBytes: z.number().int().min(0), usedByAppBytes: z.number().int().min(0).optional() }).optional(),
  screenSharing: z.boolean().optional(),
  appVersion: z.string().max(32).optional(),
});
export type DeviceState = z.infer<typeof deviceStateSchema>;

export const deviceMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), deviceId: z.string().max(64), ts: z.number().int(), sig: z.string().max(200) }),
  z.object({ type: z.literal('state'), state: deviceStateSchema }),
  z.object({ type: z.literal('ack'), commandId: z.string().max(64), status: z.enum(['received', 'done', 'error']), error: z.string().max(300).optional() }),
  z.object({ type: z.literal('download.progress'), playlistId: z.string().max(64), done: z.number().int().min(0), total: z.number().int().min(0), bytes: z.number().int().min(0).optional(), failed: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('links.request'), reqId: z.string().max(64), kind: z.enum(['stream', 'download', 'cover']), ids: z.array(trackId).min(1).max(50) }),
  z.object({ type: z.literal('screen.signal'), sessionId: z.string().max(64), kind: z.enum(['offer', 'answer', 'ice']), data: z.string().max(20_000) }),
  z.object({ type: z.literal('ping') }),
]);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

// ---- Messages Controller <-> serveur ----
export const controllerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().max(200) }),
  z.object({ type: z.literal('ping') }),
]);
