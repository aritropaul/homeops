import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const REQUIRED: Record<string, string> = {
  HOMEOPS_KEY: 'k',
  SMARTRENT_EMAIL: 'e@x.com',
  SMARTRENT_PASSWORD: 'p',
  SMARTRENT_UNIT_ID: '1',
  LOCK_ID: '2',
  THERMOSTAT_B1_ID: '3',
  THERMOSTAT_B2_ID: '4',
  THERMOSTAT_B3_ID: '5',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 't',
};

const SAVED = { ...process.env };

beforeEach(() => {
  // Wipe all keys we manipulate plus the optional ones.
  for (const k of [
    ...Object.keys(REQUIRED),
    'PREHEAT_MODE',
    'POLL_SECONDS',
    'AUTOLOCK_MINUTES',
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = { ...SAVED };
});

async function freshConfig() {
  const mod = await import('../src/config.js');
  mod.__resetConfigForTests();
  return mod.loadConfig();
}

describe('config', () => {
  it('loads with all required env set', async () => {
    const c = await freshConfig();
    expect(c.homeopsKey).toBe('k');
    expect(c.smartrent.email).toBe('e@x.com');
  });

  it('throws when a required env is missing', async () => {
    delete process.env.HOMEOPS_KEY;
    const mod = await import('../src/config.js');
    mod.__resetConfigForTests();
    expect(() => mod.loadConfig()).toThrow(/HOMEOPS_KEY/);
  });

  it('uses default PREHEAT_MODE=heat when unset', async () => {
    const c = await freshConfig();
    expect(c.preheat.mode).toBe('heat');
  });

  it('accepts a valid PREHEAT_MODE', async () => {
    process.env.PREHEAT_MODE = 'cool';
    const c = await freshConfig();
    expect(c.preheat.mode).toBe('cool');
  });

  it('rejects an invalid PREHEAT_MODE at load time', async () => {
    process.env.PREHEAT_MODE = 'frosty';
    const mod = await import('../src/config.js');
    mod.__resetConfigForTests();
    expect(() => mod.loadConfig()).toThrow(/PREHEAT_MODE/);
  });

  it('rejects non-integer POLL_SECONDS', async () => {
    process.env.POLL_SECONDS = 'thirty';
    const mod = await import('../src/config.js');
    mod.__resetConfigForTests();
    expect(() => mod.loadConfig()).toThrow(/POLL_SECONDS/);
  });
});
