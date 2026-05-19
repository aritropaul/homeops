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
} from './types.js';

const STORE_KEY = 'homeops:state';

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
    action: 'unlock' | 'lock' | 'preheat' | 'autolock',
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
    }
    if (!lastTs) return false;
    const elapsed = Date.now() - new Date(lastTs).getTime();
    return elapsed < minMs;
  }

  async recordAction(action: 'unlock' | 'lock' | 'preheat' | 'autolock'): Promise<void> {
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
    }
    await this.saveState(state);
  }
}

let storeInstance: StateStore | null = null;

export function getStore(): StateStore {
  if (!storeInstance) {
    storeInstance = new StateStore();
  }
  return storeInstance;
}
