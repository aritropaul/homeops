import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set the env config needs before importing anything that touches it.
process.env.HOMEOPS_KEY = 'k';
process.env.SMARTRENT_EMAIL = 'e@x.com';
process.env.SMARTRENT_PASSWORD = 'p';
process.env.SMARTRENT_UNIT_ID = '1';
process.env.LOCK_ID = '2';
process.env.THERMOSTAT_B1_ID = '3';
process.env.THERMOSTAT_B2_ID = '4';
process.env.THERMOSTAT_B3_ID = '5';
process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

// Fake the Upstash client so the store has somewhere to read/write without a network.
const fakeKv = new Map<string, unknown>();
vi.mock('@upstash/redis', () => ({
  Redis: class {
    async get(key: string) {
      return fakeKv.get(key) ?? null;
    }
    async set(key: string, value: unknown) {
      fakeKv.set(key, value);
    }
  },
}));

const { StateStore } = await import('../src/store.js');

describe('StateStore throttle logic', () => {
  beforeEach(() => {
    fakeKv.clear();
  });

  it('returns false on first call (nothing recorded yet)', async () => {
    const store = new StateStore();
    expect(await store.isThrottled('unlock', 60_000)).toBe(false);
  });

  it('returns true immediately after recordAction within the window', async () => {
    const store = new StateStore();
    await store.recordAction('unlock');
    expect(await store.isThrottled('unlock', 60_000)).toBe(true);
  });

  it('returns false once minMs has elapsed', async () => {
    const store = new StateStore();
    await store.recordAction('unlock');
    expect(await store.isThrottled('unlock', 60_000)).toBe(true);
    expect(await store.isThrottled('unlock', 0)).toBe(false);
  });

  it('tracks each action separately', async () => {
    const store = new StateStore();
    await store.recordAction('unlock');
    expect(await store.isThrottled('unlock', 60_000)).toBe(true);
    expect(await store.isThrottled('lock', 60_000)).toBe(false);
    expect(await store.isThrottled('preheat', 60_000)).toBe(false);
    expect(await store.isThrottled('autolock', 60_000)).toBe(false);
  });

  it('persists state to the fake KV', async () => {
    const store = new StateStore();
    await store.recordAction('preheat');
    expect(fakeKv.has('homeops:state')).toBe(true);
    // New store reads from KV.
    const fresh = new StateStore();
    expect(await fresh.isThrottled('preheat', 60_000)).toBe(true);
  });
});

describe('StateStore.updatePollStatus', () => {
  beforeEach(() => fakeKv.clear());

  it('sets lastPollTs on success', async () => {
    const store = new StateStore();
    await store.updatePollStatus(true);
    const state = await store.getState();
    expect(state.lastPollTs).toBeTruthy();
    expect(state.lastError).toBeUndefined();
  });

  it('sets lastErrorTs and lastError on failure', async () => {
    const store = new StateStore();
    await store.updatePollStatus(false, 'boom');
    const state = await store.getState();
    expect(state.lastErrorTs).toBeTruthy();
    expect(state.lastError).toBe('boom');
  });
});
