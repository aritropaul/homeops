/**
 * State Store with Upstash Redis
 * Persists device states, tracking data, and auth tokens
 */
import { Redis } from '@upstash/redis';
import { config } from './config.js';
import { logger } from './logger.js';
import type {
  HomeOpsState,
  LockDeviceState,
  ThermostatDeviceState,
  LockTracking,
  Throttles,
  Occupancy,
  ManualOverride,
  ComfortDecision,
  ThermalSample,
} from './types.js';

const STORE_KEY = 'homeops:state';
const THERMAL_KEY = 'homeops:thermal';
// Keep ~3h of history at a 30s poll: plenty to learn rates, bounded in size.
const THERMAL_MAX_SAMPLES = 360;

function createDefaultState(): HomeOpsState {
  const now = new Date().toISOString();
  return {
    devices: {
      L1: { deviceId: 'L1', lockState: 'unknown', ts: now, online: false },
      B1: { deviceId: 'B1', mode: 'unknown', ts: now, online: false },
      B2: { deviceId: 'B2', mode: 'unknown', ts: now, online: false },
      B3: { deviceId: 'B3', mode: 'unknown', ts: now, online: false },
    },
    lockTracking: {},
    throttles: {},
  };
}

export class StateStore {
  private redis: Redis;
  private cachedState: HomeOpsState | null = null;

  constructor() {
    this.redis = new Redis({
      url: config.redis.url,
      token: config.redis.token,
    });
  }

  async getState(): Promise<HomeOpsState> {
    if (this.cachedState) {
      return this.cachedState;
    }
    try {
      const data = await this.redis.get<HomeOpsState>(STORE_KEY);
      if (data) {
        this.cachedState = data;
        return data;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load state from Redis');
    }
    const defaultState = createDefaultState();
    this.cachedState = defaultState;
    return defaultState;
  }

  async saveState(state: HomeOpsState): Promise<void> {
    this.cachedState = state;
    try {
      await this.redis.set(STORE_KEY, state);
    } catch (err) {
      logger.error({ err }, 'Failed to save state to Redis');
      throw err;
    }
  }

  async updateState(updates: Partial<HomeOpsState>): Promise<HomeOpsState> {
    const current = await this.getState();
    const newState: HomeOpsState = {
      ...current,
      ...updates,
      devices: { ...current.devices, ...(updates.devices || {}) },
      lockTracking: { ...current.lockTracking, ...(updates.lockTracking || {}) },
      throttles: { ...current.throttles, ...(updates.throttles || {}) },
    };
    await this.saveState(newState);
    return newState;
  }

  async updateLockState(lockState: LockDeviceState): Promise<void> {
    const state = await this.getState();
    state.devices.L1 = lockState;
    await this.saveState(state);
  }

  async updateThermostatState(
    deviceId: 'B1' | 'B2' | 'B3',
    thermostatState: ThermostatDeviceState,
  ): Promise<void> {
    const state = await this.getState();
    state.devices[deviceId] = thermostatState;
    await this.saveState(state);
  }

  async updateLockTracking(tracking: Partial<LockTracking>): Promise<void> {
    const state = await this.getState();
    state.lockTracking = { ...state.lockTracking, ...tracking };
    await this.saveState(state);
  }

  async updateThrottles(throttles: Partial<Throttles>): Promise<void> {
    const state = await this.getState();
    state.throttles = { ...state.throttles, ...throttles };
    await this.saveState(state);
  }

  async updatePollStatus(success: boolean, error?: string): Promise<void> {
    const now = new Date().toISOString();
    const state = await this.getState();
    if (success) {
      state.lastPollTs = now;
    } else {
      state.lastErrorTs = now;
      state.lastError = error;
    }
    await this.saveState(state);
  }

  clearCache(): void {
    this.cachedState = null;
  }

  async isThrottled(
    action: 'unlock' | 'lock' | 'preheat' | 'autolock' | 'comfort',
    minMs: number,
  ): Promise<boolean> {
    const state = await this.getState();
    let lastTs: string | undefined;
    switch (action) {
      case 'unlock':
        lastTs = state.throttles.lastUnlockAt;
        break;
      case 'lock':
        lastTs = state.throttles.lastLockAt;
        break;
      case 'preheat':
        lastTs = state.throttles.lastPreheatAt;
        break;
      case 'autolock':
        lastTs = state.lockTracking.lastAutoLockAttempt;
        break;
      case 'comfort':
        lastTs = state.throttles.lastComfortAt;
        break;
    }
    if (!lastTs) return false;
    const elapsed = Date.now() - new Date(lastTs).getTime();
    return elapsed < minMs;
  }

  async recordAction(
    action: 'unlock' | 'lock' | 'preheat' | 'autolock' | 'comfort',
  ): Promise<void> {
    const now = new Date().toISOString();
    const state = await this.getState();
    switch (action) {
      case 'unlock':
        state.throttles.lastUnlockAt = now;
        break;
      case 'lock':
        state.throttles.lastLockAt = now;
        break;
      case 'preheat':
        state.throttles.lastPreheatAt = now;
        break;
      case 'autolock':
        state.lockTracking.lastAutoLockAttempt = now;
        break;
      case 'comfort':
        state.throttles.lastComfortAt = now;
        break;
    }
    await this.saveState(state);
  }

  // ── Comfort engine state ───────────────────────────────────────────────────

  /** Set the comfort intent (home/away/arriving/sleep). */
  async setOccupancy(intent: Occupancy, etaTs?: string): Promise<void> {
    const state = await this.getState();
    state.occupancy = { intent, since: new Date().toISOString(), etaTs };
    await this.saveState(state);
  }

  /** Current intent, defaulting to 'home' when never set. */
  async getOccupancy(): Promise<Occupancy> {
    const state = await this.getState();
    return state.occupancy?.intent ?? 'home';
  }

  /** Pin a manual setpoint on B2 for the configured TTL. */
  async setManualOverride(
    setpointF: number,
    mode: ManualOverride['mode'],
    ttlMs: number,
  ): Promise<void> {
    const state = await this.getState();
    state.manualOverride = {
      setpointF,
      mode,
      untilTs: new Date(Date.now() + ttlMs).toISOString(),
    };
    await this.saveState(state);
  }

  /** Returns the override only if it hasn't expired; clears it if it has. */
  async getActiveOverride(): Promise<ManualOverride | null> {
    const state = await this.getState();
    const ov = state.manualOverride;
    if (!ov) return null;
    if (Date.now() >= new Date(ov.untilTs).getTime()) {
      state.manualOverride = undefined;
      await this.saveState(state);
      return null;
    }
    return ov;
  }

  async clearManualOverride(): Promise<void> {
    const state = await this.getState();
    if (state.manualOverride) {
      state.manualOverride = undefined;
      await this.saveState(state);
    }
  }

  async setLastComfortDecision(decision: ComfortDecision): Promise<void> {
    const state = await this.getState();
    state.lastComfortDecision = decision;
    await this.saveState(state);
  }

  // ── Thermal history (separate key so the main state blob stays small) ───────

  async appendThermalSample(sample: ThermalSample): Promise<void> {
    try {
      const existing = (await this.redis.get<ThermalSample[]>(THERMAL_KEY)) ?? [];
      existing.push(sample);
      const trimmed = existing.slice(-THERMAL_MAX_SAMPLES);
      await this.redis.set(THERMAL_KEY, trimmed);
    } catch (err) {
      // Thermal history is best-effort; never let it break the poll.
      logger.warn({ err }, 'Failed to append thermal sample');
    }
  }

  async getThermalSamples(): Promise<ThermalSample[]> {
    try {
      return (await this.redis.get<ThermalSample[]>(THERMAL_KEY)) ?? [];
    } catch (err) {
      logger.warn({ err }, 'Failed to read thermal samples');
      return [];
    }
  }
}

let storeInstance: StateStore | null = null;

export function getStore(): StateStore {
  if (!storeInstance) {
    storeInstance = new StateStore();
  }
  return storeInstance;
}
