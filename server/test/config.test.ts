import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const dir = () => mkdtempSync(join(tmpdir(), 'nial-cfg-'));
const base = (d: string) => ({ PUBLIC_URL: 'https://nial.example.org', DATA_DIR: d, NAVIDROME_URL: 'http://127.0.0.1:4533', NAVIDROME_USER: 'svc', NAVIDROME_PASSWORD: 'pw', RELAY_ENABLED: '1' });

describe('configuration', () => {
  it('accepte une configuration valide et genere un secret de flux protege (0600)', () => {
    const d = dir();
    const c = loadConfig(base(d));
    expect(c.streamSecrets[0]!.length).toBeGreaterThanOrEqual(32);
    expect(statSync(join(d, 'stream-secrets')).mode & 0o777).toBe(0o600);
    expect(loadConfig(base(d)).streamSecrets).toEqual(c.streamSecrets); // stable entre redemarrages
  });
  it('exige HTTPS en production', () => {
    expect(() => loadConfig({ ...base(dir()), NODE_ENV: 'production', PUBLIC_URL: 'http://nial.local' })).toThrow(/https/);
  });
  it('exige une passerelle de flux ou le relais', () => {
    const { RELAY_ENABLED: _r, ...rest } = base(dir());
    expect(() => loadConfig(rest)).toThrow(/STREAM_BASE_URL/);
    expect(loadConfig({ ...rest, STREAM_BASE_URL: 'https://stream.example.org' }).relayEnabled).toBe(false);
  });
  it('refuse les secrets de flux trop courts et lit les secrets depuis un fichier', () => {
    const d = dir();
    expect(() => loadConfig({ ...base(d), STREAM_SECRETS: 'court' })).toThrow(/32/);
    const f = join(d, 'pw'); writeFileSync(f, 'depuis-fichier\n');
    const { NAVIDROME_PASSWORD: _p, ...rest } = base(d);
    expect(loadConfig({ ...rest, NAVIDROME_PASSWORD_FILE: f }).navidromePassword).toBe('depuis-fichier');
  });
  it('ignore tout multiplicateur de limites de debit hors tests', () => {
    expect(loadConfig({ ...base(dir()), RATE_LIMIT_MULTIPLIER: '1000' } as NodeJS.ProcessEnv).rateLimitMultiplier).toBe(1);
  });
});
