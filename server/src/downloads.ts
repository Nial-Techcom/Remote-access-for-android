import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { nowMs } from './db.js';
import type { NavidromeClient, Song } from './navidrome.js';
import { NavidromeError } from './navidrome.js';

export interface ManifestTrack {
  id: string; size: number; sha256: string; suffix: string; title: string; artist: string; album: string; durationSec: number; coverId?: string;
}

const HASH_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Navidrome ne fournit pas d'empreinte de fichier : le serveur lit chaque morceau une fois via `download`
 * (fichier original, pas de transcodage) et memorise son SHA-256. Les telephones verifient ensuite cette empreinte.
 */
export class ManifestService {
  private inflight = new Map<string, Promise<string>>();

  constructor(private readonly db: Db, private readonly nav: NavidromeClient) {}

  cachedHash(songId: string, size: number): string | null {
    const r = this.db.prepare('SELECT sha256, updated_at FROM song_hashes WHERE song_id = ? AND size = ?').get(songId, size) as { sha256: string; updated_at: number } | undefined;
    return r && r.updated_at > nowMs() - HASH_TTL_MS ? r.sha256 : null;
  }

  private async hashSong(song: Song): Promise<string> {
    const cached = this.cachedHash(song.id, song.size);
    if (cached) return cached;
    const key = `${song.id}:${song.size}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const res = await this.nav.fetchRaw(this.nav.upstreamUrl('download', song.id), { signal: AbortSignal.timeout(10 * 60_000) });
      const ct = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || ct.includes('json') || ct.includes('xml')) throw new NavidromeError(`Telechargement impossible pour ${song.id}`);
      const h = createHash('sha256');
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > MAX_FILE_BYTES) throw new NavidromeError('Fichier trop volumineux');
        h.update(chunk);
      }
      const hex = h.digest('hex');
      this.db.prepare('INSERT INTO song_hashes (song_id, size, sha256, updated_at) VALUES (?,?,?,?) ON CONFLICT(song_id, size) DO UPDATE SET sha256 = excluded.sha256, updated_at = excluded.updated_at').run(song.id, song.size, hex, nowMs());
      return hex;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Construit le manifeste d'une playlist. Concurrence limitee pour ne pas saturer Navidrome. */
  async build(playlistId: string, onProgress?: (done: number, total: number) => void): Promise<{ tracks: ManifestTrack[]; totalBytes: number }> {
    const pl = await this.nav.playlist(playlistId);
    const songs = pl.songs ?? [];
    const out: ManifestTrack[] = new Array(songs.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= songs.length) return;
        const s = songs[i] as Song;
        const sha256 = await this.hashSong(s);
        out[i] = { id: s.id, size: s.size, sha256, suffix: s.suffix, title: s.title, artist: s.artist, album: s.album, durationSec: s.durationSec, coverId: s.coverId };
        onProgress?.(++done, songs.length);
      }
    };
    await Promise.all([worker(), worker()]);
    return { tracks: out, totalBytes: out.reduce((a, t) => a + t.size, 0) };
  }
}
