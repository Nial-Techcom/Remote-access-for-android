import { createHash, randomBytes } from 'node:crypto';

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId?: string;
  durationSec: number;
  size: number;
  suffix: string;
  coverId?: string;
  track?: number;
}
export interface Album { id: string; name: string; artist: string; coverId?: string; year?: number; songCount?: number; songs?: Song[] }
export interface Artist { id: string; name: string; albumCount?: number; coverId?: string; albums?: Album[] }
export interface Playlist { id: string; name: string; songCount: number; durationSec: number; coverId?: string; songs?: Song[] }

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/* eslint-disable @typescript-eslint/no-explicit-any */
export class NavidromeError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/**
 * Client Subsonic/OpenSubsonic pour Navidrome.
 * Les identifiants Navidrome ne sortent jamais de ce module : les applications recoivent uniquement
 * des DTO et des liens signes vers la passerelle de flux.
 */
export class NavidromeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Parametres d'authentification Subsonic (jeton = md5(mot de passe + sel)). Un sel neuf par requete. */
  private authParams(): URLSearchParams {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(this.password + salt).digest('hex');
    return new URLSearchParams({ u: this.user, t: token, s: salt, v: '1.16.1', c: 'nial-control', f: 'json' });
  }

  /** URL interne vers Navidrome. Jamais renvoyee a un client. */
  upstreamUrl(endpoint: 'stream' | 'download' | 'getCoverArt', id: string, extra: Record<string, string> = {}): string {
    if (!isValidId(id)) throw new NavidromeError('Identifiant invalide', 400);
    const p = this.authParams();
    p.set('id', id);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `${this.baseUrl}/rest/${endpoint}.view?${p.toString()}`;
  }

  private async call(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    const p = this.authParams();
    for (const [k, v] of Object.entries(params)) p.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/rest/${endpoint}.view?${p.toString()}`, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new NavidromeError('Navidrome injoignable');
    }
    if (!res.ok) throw new NavidromeError(`Navidrome a repondu ${res.status}`);
    const body = (await res.json().catch(() => null)) as any;
    const r = body?.['subsonic-response'];
    if (!r || r.status !== 'ok') throw new NavidromeError(r?.error?.message ? `Navidrome : ${String(r.error.message).slice(0, 120)}` : 'Reponse Navidrome invalide');
    return r;
  }

  private song(s: any): Song {
    return { id: String(s.id), title: String(s.title ?? ''), artist: String(s.artist ?? ''), album: String(s.album ?? ''), albumId: s.albumId ? String(s.albumId) : undefined, durationSec: Number(s.duration ?? 0), size: Number(s.size ?? 0), suffix: String(s.suffix ?? ''), coverId: s.coverArt ? String(s.coverArt) : undefined, track: s.track !== undefined ? Number(s.track) : undefined };
  }
  private album(a: any): Album {
    return { id: String(a.id), name: String(a.name ?? a.title ?? ''), artist: String(a.artist ?? ''), coverId: a.coverArt ? String(a.coverArt) : undefined, year: a.year, songCount: a.songCount, songs: Array.isArray(a.song) ? a.song.map((s: any) => this.song(s)) : undefined };
  }

  async ping(): Promise<boolean> { await this.call('ping'); return true; }

  async artists(): Promise<Artist[]> {
    const r = await this.call('getArtists');
    const out: Artist[] = [];
    for (const idx of r.artists?.index ?? []) for (const a of idx.artist ?? []) out.push({ id: String(a.id), name: String(a.name), albumCount: a.albumCount, coverId: a.coverArt ? String(a.coverArt) : undefined });
    return out;
  }
  async artist(id: string): Promise<Artist> {
    if (!isValidId(id)) throw new NavidromeError('Identifiant invalide', 400);
    const a = (await this.call('getArtist', { id })).artist;
    return { id: String(a.id), name: String(a.name), albums: (a.album ?? []).map((x: any) => this.album(x)) };
  }
  async albumById(id: string): Promise<Album> {
    if (!isValidId(id)) throw new NavidromeError('Identifiant invalide', 400);
    return this.album((await this.call('getAlbum', { id })).album);
  }
  async playlists(): Promise<Playlist[]> {
    const r = await this.call('getPlaylists');
    return (r.playlists?.playlist ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name), songCount: Number(p.songCount ?? 0), durationSec: Number(p.duration ?? 0), coverId: p.coverArt ? String(p.coverArt) : undefined }));
  }
  async playlist(id: string): Promise<Playlist> {
    if (!isValidId(id)) throw new NavidromeError('Identifiant invalide', 400);
    const p = (await this.call('getPlaylist', { id })).playlist;
    return { id: String(p.id), name: String(p.name), songCount: Number(p.songCount ?? 0), durationSec: Number(p.duration ?? 0), coverId: p.coverArt ? String(p.coverArt) : undefined, songs: (p.entry ?? []).map((s: any) => this.song(s)) };
  }
  async song_(id: string): Promise<Song> {
    if (!isValidId(id)) throw new NavidromeError('Identifiant invalide', 400);
    return this.song((await this.call('getSong', { id })).song);
  }
  async search(query: string): Promise<{ artists: Artist[]; albums: Album[]; songs: Song[] }> {
    const r = (await this.call('search3', { query: query.slice(0, 100), artistCount: '10', albumCount: '20', songCount: '40' })).searchResult3 ?? {};
    return {
      artists: (r.artist ?? []).map((a: any) => ({ id: String(a.id), name: String(a.name) })),
      albums: (r.album ?? []).map((a: any) => this.album(a)),
      songs: (r.song ?? []).map((s: any) => this.song(s)),
    };
  }
  async fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    try { return await this.fetchImpl(url, init); } catch { throw new NavidromeError('Navidrome injoignable'); }
  }
}
