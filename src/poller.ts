/**
 * Device Poller, WebSocket Subscriber, and Auto-Lock Rule Engine
 *
 * State sources, in order of freshness:
 *   1. Phoenix WebSocket — push updates for the attrs SmartRent ships in real time
 *      (locked, notifications, mode, temps, humidity, fan_mode, operating_state).
 *   2. REST poll — periodic snapshot; the only source for battery_level / online.
 *
 * REST polling runs on a chained setTimeout so a slow cycle can never overlap
 * with the next one.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { SmartRentClient, parseLockState, parseThermostatState } from './smartrent.js';
import { SmartRentSocket, type AttributeEvent } from './socket.js';
import { getStore } from './store.js';
import type {
  SmartRentDevice,
  LockDeviceState,
  ThermostatDeviceState,
  LockTracking,
  ThermostatMode,
} from './types.js';

let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;
let smartRentClient: SmartRentClient | null = null;
let socket: SmartRentSocket | null = null;
let stopRequested = false;

export function getSmartRentClient(): SmartRentClient {
  if (!smartRentClient) {
    smartRentClient = new SmartRentClient({
      email: config.smartrent.email,
      password: config.smartrent.password,
      unitId: config.smartrent.unitId,
    });
  }
  return smartRentClient;
}

function deviceIdToKey(id: string): 'L1' | 'B1' | 'B2' | 'B3' | null {
  if (id === config.devices.lockId) return 'L1';
  if (id === config.devices.thermostatB1Id) return 'B1';
  if (id === config.devices.thermostatB2Id) return 'B2';
  if (id === config.devices.thermostatB3Id) return 'B3';
  return null;
}

function mapDeviceId(device: SmartRentDevice): 'L1' | 'B1' | 'B2' | 'B3' | null {
  return deviceIdToKey(String(device.id));
}

// ── REST poll ───────────────────────────────────────────────────────────────

export async function pollDevices(): Promise<void> {
  const client = getSmartRentClient();
  const store = getStore();
  const now = new Date().toISOString();
  const t0 = Date.now();

  try {
    // Use the unit-level list endpoint, NOT /api/v2/devices/:id. The
    // single-device endpoint echoes the last-written value into `state` for a
    // window after PATCH writes — even when the physical device never
    // confirmed the change. The list endpoint reports the true confirmed
    // state plus a separate `pending_state` field for in-flight writes.
    const devices = await client.getDevices();
    const state = await store.getState();

    for (const device of devices) {
      const deviceId = mapDeviceId(device);
      if (!deviceId) continue;

      if (deviceId === 'L1' && device.type === 'entry_control') {
        state.devices.L1 = {
          deviceId: 'L1',
          lockState: parseLockState(device),
          batteryPct: device.battery_level,
          online: device.online,
          ts: now,
          lastNotification: state.devices.L1.lastNotification,
          lastNotificationTs: state.devices.L1.lastNotificationTs,
        };
      } else if (
        (deviceId === 'B1' || deviceId === 'B2' || deviceId === 'B3') &&
        device.type === 'thermostat'
      ) {
        const t = parseThermostatState(device);
        state.devices[deviceId] = {
          deviceId,
          mode: t.mode,
          currentTempF: t.currentTempF,
          targetTempF: t.targetTempF,
          humidityPct: t.humidityPct,
          online: device.online,
          ts: now,
          pendingMode: t.pendingMode,
          pendingTargetTempF: t.pendingTargetTempF,
        };
      }
    }

    await runAutoLockRule(state.devices.L1, state.lockTracking);

    state.lastPollTs = now;
    await store.saveState(state);
    logger.debug({ durationMs: Date.now() - t0 }, 'REST poll complete');
  } catch (err) {
    logger.error({ err, durationMs: Date.now() - t0 }, 'REST poll failed');
    await store.updatePollStatus(false, err instanceof Error ? err.message : 'Unknown error');
    throw err;
  }
}

async function pollLoop(): Promise<void> {
  if (stopRequested) return;
  if (pollInFlight) {
    schedulePoll();
    return;
  }
  pollInFlight = true;
  try {
    await pollDevices();
  } catch {
    // Already logged.
  } finally {
    pollInFlight = false;
    schedulePoll();
  }
}

function schedulePoll(): void {
  if (stopRequested) return;
  pollTimer = setTimeout(() => void pollLoop(), config.pollSeconds * 1000);
}

// ── WebSocket attribute handler ─────────────────────────────────────────────

async function applyAttributeEvent(event: AttributeEvent): Promise<void> {
  const key = deviceIdToKey(event.deviceId);
  if (!key) return;

  const store = getStore();
  const state = await store.getState();
  const now = new Date().toISOString();

  if (key === 'L1') {
    const lock = state.devices.L1;
    if (event.name === 'locked') {
      const next: LockDeviceState = {
        ...lock,
        ts: now,
        lockState: event.value === 'true' ? 'locked' : event.value === 'false' ? 'unlocked' : 'unknown',
      };
      state.devices.L1 = next;
      await runAutoLockRule(next, state.lockTracking);
    } else if (event.name === 'notifications') {
      state.devices.L1 = {
        ...lock,
        ts: now,
        lastNotification: event.value,
        lastNotificationTs: now,
      };
      logger.info({ deviceId: event.deviceId, notification: event.value }, 'Lock notification');
    } else {
      return; // ignore other attrs on lock
    }
  } else {
    const therm = state.devices[key];
    const updated: ThermostatDeviceState = { ...therm, ts: now };
    switch (event.name) {
      case 'mode': {
        const raw = event.value === 'aux_heat' ? 'heat' : event.value;
        const valid: ThermostatMode[] = ['heat', 'cool', 'auto', 'off'];
        updated.mode = (valid as string[]).includes(raw) ? (raw as ThermostatMode) : 'unknown';
        break;
      }
      case 'current_temp':
        updated.currentTempF = parseInt(event.value, 10) || undefined;
        break;
      case 'heating_setpoint':
        if (updated.mode === 'heat' || updated.mode === 'auto' || !updated.targetTempF) {
          updated.targetTempF = parseInt(event.value, 10) || undefined;
        }
        break;
      case 'cooling_setpoint':
        if (updated.mode === 'cool') {
          updated.targetTempF = parseInt(event.value, 10) || undefined;
        }
        break;
      case 'current_humidity':
        updated.humidityPct = parseInt(event.value, 10) || undefined;
        break;
      default:
        return; // fan_mode / operating_state — captured at REST poll time
    }
    state.devices[key] = updated;
  }

  await store.saveState(state);
}

// ── Auto-lock rule ──────────────────────────────────────────────────────────

async function runAutoLockRule(
  lockState: LockDeviceState,
  lockTracking: LockTracking,
): Promise<void> {
  const store = getStore();
  const now = Date.now();
  const autolockMs = config.autolockMinutes * 60 * 1000;

  if (lockState.lockState === 'unlocked') {
    if (!lockTracking.unlockedSince) {
      logger.info('Lock unlocked, starting auto-lock timer');
      await store.updateLockTracking({ unlockedSince: new Date().toISOString() });
      return;
    }
    const elapsed = now - new Date(lockTracking.unlockedSince).getTime();
    if (elapsed >= autolockMs) {
      if (await store.isThrottled('autolock', config.throttles.autolockAttemptMinMs)) return;
      logger.info({ elapsedMinutes: Math.floor(elapsed / 60000) }, 'Auto-lock triggered');
      try {
        await getSmartRentClient().lock(config.devices.lockId);
        await store.recordAction('autolock');
        logger.info('Auto-lock successful');
      } catch (err) {
        logger.error({ err }, 'Auto-lock failed');
        await store.recordAction('autolock');
      }
    }
  } else if (lockState.lockState === 'locked' && lockTracking.unlockedSince) {
    await store.updateLockTracking({ unlockedSince: undefined });
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function startPoller(): void {
  if (pollTimer || pollInFlight || socket) {
    logger.warn('Poller already running');
    return;
  }
  stopRequested = false;

  // Real-time updates via WebSocket.
  const deviceIds = [
    config.devices.lockId,
    config.devices.thermostatB1Id,
    config.devices.thermostatB2Id,
    config.devices.thermostatB3Id,
  ];
  socket = new SmartRentSocket(getSmartRentClient(), deviceIds);
  socket.onAttribute((event) => {
    applyAttributeEvent(event).catch((err) =>
      logger.error({ err, event }, 'Failed to apply WS event'),
    );
  });
  socket.start();

  // REST snapshot — needed for battery_level/online and as a safety net.
  logger.info({ intervalSeconds: config.pollSeconds }, 'Starting REST poller');
  void pollLoop();
}

export function stopPoller(): void {
  stopRequested = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (socket) {
    socket.stop();
    socket = null;
  }
  logger.info('Poller stopped');
}

export function isPollerRunning(): boolean {
  return pollTimer !== null || pollInFlight || socket !== null;
}

export function isSocketConnected(): boolean {
  return socket?.isConnected() ?? false;
}
