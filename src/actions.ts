/**
 * HomeOps Actions
 * Business logic for arrive, leave, lock, unlock, and preheat operations.
 *
 * Each composite action (/arrive, /leave) runs its sub-operations independently
 * so a thermostat failure does not block the lock, and vice versa.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { getSmartRentClient, runComfortControl } from './poller.js';
import { getStore } from './store.js';
import type { HomeOpsResponse, ThermostatMode, ComfortDecision } from './types.js';

function respond(message: string): HomeOpsResponse {
  return { ok: true, response: message };
}

function respondError(message: string): HomeOpsResponse {
  return { ok: false, response: message };
}

/** Short human summary of an engine decision for the Shortcut's spoken reply. */
function comfortMsg(d: ComfortDecision): string {
  return d.mode === 'off' ? 'climate idle' : `${d.mode} to ${d.setpointF}°F`;
}

const THERMOSTAT_MAP: Record<string, { name: string; deviceId: string }> = {
  aritro: { name: 'Aritro', deviceId: config.devices.thermostatB2Id },
  adhya: { name: 'Adhya', deviceId: config.devices.thermostatB1Id },
  living: { name: 'Living Room', deviceId: config.devices.thermostatB3Id },
  livingroom: { name: 'Living Room', deviceId: config.devices.thermostatB3Id },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

// Run an operation, swallow errors into a log+result string.
async function runStep(
  name: string,
  fn: () => Promise<string | null>,
): Promise<{ ok: true; msg: string } | { ok: false; msg: string }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    logger.info({ action: name, outcome: 'success', durationMs: Date.now() - t0 }, 'Action ok');
    return result ? { ok: true, msg: result } : { ok: true, msg: '' };
  } catch (err) {
    logger.error(
      { action: name, outcome: 'error', durationMs: Date.now() - t0, err },
      'Action failed',
    );
    return { ok: false, msg: `${name} failed: ${errMsg(err)}` };
  }
}

export async function handleArrive(): Promise<HomeOpsResponse> {
  logger.info('Processing /arrive');
  const store = getStore();
  const client = getSmartRentClient();
  const ok: string[] = [];
  const fail: string[] = [];

  // Coming home is a fresh intent: resume auto control and clear any stale pin.
  await store.clearManualOverride();
  await store.setOccupancy('home');

  const unlock = await runStep('arrive.unlock', async () => {
    if (await store.isThrottled('unlock', config.throttles.unlockMinMs)) return null;
    const state = await store.getState();
    if (state.devices.L1.lockState === 'unlocked') return 'door already unlocked';
    if (state.devices.L1.lockState === 'unknown') return 'door state unknown, skipped unlock';
    await client.unlock(config.devices.lockId);
    await store.recordAction('unlock');
    return 'door unlocked';
  });
  if (unlock.ok && unlock.msg) ok.push(unlock.msg);
  if (!unlock.ok) fail.push(unlock.msg);

  // Drive B2 to the home comfort band right now (force past the rate limit).
  const comfort = await runStep('arrive.comfort', async () => {
    const decision = await runComfortControl({ force: true });
    return decision ? comfortMsg(decision) : null;
  });
  if (comfort.ok && comfort.msg) ok.push(comfort.msg);
  if (!comfort.ok) fail.push(comfort.msg);

  if (ok.length === 0 && fail.length === 0) return respond('Welcome home!');
  if (fail.length > 0 && ok.length === 0) return respondError(`Arrive: ${fail.join('; ')}`);
  if (fail.length > 0) return respond(`Welcome home! ${ok.join(', ')} (failures: ${fail.join('; ')})`);
  return respond(`Welcome home! ${ok.join(', ')}`);
}

export async function handleLeave(): Promise<HomeOpsResponse> {
  logger.info('Processing /leave');
  const store = getStore();
  const client = getSmartRentClient();
  const ok: string[] = [];
  const fail: string[] = [];

  // Leaving is a fresh intent: drop any manual pin, switch to the away coast band.
  await store.clearManualOverride();
  await store.setOccupancy('away');

  const lock = await runStep('leave.lock', async () => {
    if (await store.isThrottled('lock', config.throttles.lockMinMs)) return null;
    const state = await store.getState();
    if (state.devices.L1.lockState === 'locked') return 'door already locked';
    await client.lock(config.devices.lockId);
    await store.recordAction('lock');
    return 'door locked';
  });
  if (lock.ok && lock.msg) ok.push(lock.msg);
  if (!lock.ok) fail.push(lock.msg);

  // Let the room coast: the engine picks the away ceiling/floor (weather-aware)
  // and turns the system off when the room is already in the coast band.
  const comfort = await runStep('leave.comfort', async () => {
    const decision = await runComfortControl({ force: true });
    return decision ? comfortMsg(decision) : null;
  });
  if (comfort.ok && comfort.msg) ok.push(comfort.msg);
  if (!comfort.ok) fail.push(comfort.msg);

  if (ok.length === 0 && fail.length === 0) return respond('Goodbye!');
  if (fail.length > 0 && ok.length === 0) return respondError(`Leave: ${fail.join('; ')}`);
  if (fail.length > 0) return respond(`Goodbye! ${ok.join(', ')} (failures: ${fail.join('; ')})`);
  return respond(`Goodbye! ${ok.join(', ')}`);
}

export async function handleLock(): Promise<HomeOpsResponse> {
  logger.info('Processing /lock');
  const store = getStore();
  const client = getSmartRentClient();
  try {
    if (await store.isThrottled('lock', config.throttles.lockMinMs)) {
      return respond('Door lock throttled, try again in a moment');
    }
    const state = await store.getState();
    if (state.devices.L1.lockState === 'locked') return respond('Door is already locked');

    await client.lock(config.devices.lockId);
    await store.recordAction('lock');
    return respond('Door locked');
  } catch (err) {
    logger.error({ err }, '/lock failed');
    return respondError(`Error locking door: ${errMsg(err)}`);
  }
}

export async function handleUnlock(): Promise<HomeOpsResponse> {
  logger.info('Processing /unlock');
  const store = getStore();
  const client = getSmartRentClient();
  try {
    if (await store.isThrottled('unlock', config.throttles.unlockMinMs)) {
      return respond('Door unlock throttled, try again in a moment');
    }
    const state = await store.getState();
    if (state.devices.L1.lockState === 'unlocked') return respond('Door is already unlocked');
    if (state.devices.L1.lockState === 'unknown') {
      return respondError('Cannot unlock: door state unknown');
    }

    await client.unlock(config.devices.lockId);
    await store.recordAction('unlock');
    return respond('Door unlocked');
  } catch (err) {
    logger.error({ err }, '/unlock failed');
    return respondError(`Error unlocking door: ${errMsg(err)}`);
  }
}

/**
 * /preheat — kept for Shortcut compatibility, but it no longer "pre-heats". It
 * now means "make B2 comfortable right now": run the engine for the current
 * intent, which picks heat, cool, or off from the real room + weather.
 */
export async function handlePreheat(): Promise<HomeOpsResponse> {
  logger.info('Processing /preheat (comfort now)');
  try {
    const decision = await runComfortControl({ force: true });
    if (!decision) return respondError('No B2 temperature reading yet — try again shortly');
    return respond(`B2: ${comfortMsg(decision)} — ${decision.reason}`);
  } catch (err) {
    logger.error({ err }, '/preheat failed');
    return respondError(`Error: ${errMsg(err)}`);
  }
}

/**
 * /arriving — "I'll be home in N minutes". Sets the arriving intent and lets the
 * engine pre-condition B2 so it hits the home target around the time you walk
 * in, using the learned cooling/heating rate (it holds off if it's too early).
 */
export async function handleArriving(etaMinutes: number): Promise<HomeOpsResponse> {
  logger.info({ etaMinutes }, 'Processing /arriving');
  const store = getStore();
  if (!Number.isFinite(etaMinutes) || etaMinutes < 0 || etaMinutes > 240) {
    return respondError('ETA must be between 0 and 240 minutes');
  }
  await store.clearManualOverride();
  const etaTs = new Date(Date.now() + etaMinutes * 60_000).toISOString();
  await store.setOccupancy('arriving', etaTs);
  try {
    const decision = await runComfortControl({ force: true });
    if (!decision) return respond(`Got it — arriving in ${etaMinutes} min`);
    if (decision.mode === 'off') {
      return respond(`Arriving in ${etaMinutes} min — ${decision.reason}`);
    }
    return respond(`Arriving in ${etaMinutes} min — preconditioning: ${comfortMsg(decision)}`);
  } catch (err) {
    logger.error({ err }, '/arriving failed');
    return respondError(`Error: ${errMsg(err)}`);
  }
}

/** /sleep — switch B2 to the cooler night target until the next presence change. */
export async function handleSleep(): Promise<HomeOpsResponse> {
  logger.info('Processing /sleep');
  const store = getStore();
  await store.clearManualOverride();
  await store.setOccupancy('sleep');
  try {
    const decision = await runComfortControl({ force: true });
    return decision
      ? respond(`Goodnight — B2: ${comfortMsg(decision)}`)
      : respond('Goodnight');
  } catch (err) {
    logger.error({ err }, '/sleep failed');
    return respondError(`Error: ${errMsg(err)}`);
  }
}

export async function handleSetThermostat(
  name: string,
  temp: number,
  modeOverride?: string,
): Promise<HomeOpsResponse> {
  logger.info({ name, temp, modeOverride }, 'Processing /thermostat');
  const store = getStore();
  const client = getSmartRentClient();
  const normalizedName = name.toLowerCase().trim();
  const thermostat = THERMOSTAT_MAP[normalizedName];

  if (!thermostat) {
    return respondError(`Unknown thermostat: ${name}. Use: aritro, adhya, or living`);
  }
  if (temp < 50 || temp > 85) {
    return respondError('Temperature must be between 50 and 85°F');
  }
  if (modeOverride && !['heat', 'cool', 'auto'].includes(modeOverride.toLowerCase())) {
    return respondError(`Invalid mode: ${modeOverride}. Use: heat, cool, or auto`);
  }

  // If caller explicitly specified a mode, honor it. Otherwise infer from the
  // thermostat's current state; fall back to the configured preheat mode.
  const state = await store.getState();
  const idMap: Record<string, 'B1' | 'B2' | 'B3'> = {
    [config.devices.thermostatB1Id]: 'B1',
    [config.devices.thermostatB2Id]: 'B2',
    [config.devices.thermostatB3Id]: 'B3',
  };
  const stateKey = idMap[thermostat.deviceId];
  const currentMode: ThermostatMode = stateKey ? state.devices[stateKey].mode : 'unknown';
  const targetMode: 'heat' | 'cool' | 'auto' = modeOverride
    ? (modeOverride.toLowerCase() as 'heat' | 'cool' | 'auto')
    : currentMode === 'heat' || currentMode === 'cool' || currentMode === 'auto'
      ? currentMode
      : config.preheat.mode;

  try {
    await client.setThermostatTarget(thermostat.deviceId, temp, targetMode);
    // A manual set on B2 pins the engine off for a while so it won't override
    // the human. Other rooms aren't engine-controlled, so no pin needed.
    let note = '';
    if (thermostat.deviceId === config.devices.thermostatB2Id) {
      await store.setManualOverride(
        temp,
        targetMode,
        config.comfort.overrideTtlMinutes * 60_000,
      );
      note = ` (auto-control paused ${config.comfort.overrideTtlMinutes} min)`;
    }
    return respond(`${thermostat.name} ${targetMode} target set to ${temp}°F${note}`);
  } catch (err) {
    logger.error({ err, name, temp }, 'Failed to set thermostat');
    return respondError(`Error setting ${thermostat.name}: ${errMsg(err)}`);
  }
}

export async function handleThermostatOff(name: string): Promise<HomeOpsResponse> {
  logger.info({ name }, 'Processing /thermostat/:name/off');
  const store = getStore();
  const client = getSmartRentClient();
  const normalizedName = name.toLowerCase().trim();
  const thermostat = THERMOSTAT_MAP[normalizedName];
  if (!thermostat) {
    return respondError(`Unknown thermostat: ${name}. Use: aritro, adhya, or living`);
  }
  try {
    await client.setThermostatMode(thermostat.deviceId, 'off');
    // Pin B2 off so the engine doesn't switch it back on.
    let note = '';
    if (thermostat.deviceId === config.devices.thermostatB2Id) {
      await store.setManualOverride(0, 'off', config.comfort.overrideTtlMinutes * 60_000);
      note = ` (auto-control paused ${config.comfort.overrideTtlMinutes} min)`;
    }
    return respond(`${thermostat.name} turned off${note}`);
  } catch (err) {
    logger.error({ err, name }, 'Failed to turn off thermostat');
    return respondError(`Error turning off ${thermostat.name}: ${errMsg(err)}`);
  }
}

export async function handleForceUnlock(): Promise<HomeOpsResponse> {
  logger.info('Processing /unlock (force)');
  const store = getStore();
  const client = getSmartRentClient();
  try {
    if (await store.isThrottled('unlock', config.throttles.unlockMinMs)) {
      return respond('Door unlock throttled, try again in a moment');
    }
    await client.unlock(config.devices.lockId);
    await store.recordAction('unlock');
    return respond('Door unlocked');
  } catch (err) {
    logger.error({ err }, 'Force unlock failed');
    return respondError(`Error unlocking door: ${errMsg(err)}`);
  }
}

export async function handleForceLock(): Promise<HomeOpsResponse> {
  logger.info('Processing /lock (force)');
  const client = getSmartRentClient();
  try {
    await client.lock(config.devices.lockId);
    return respond('Door locked');
  } catch (err) {
    logger.error({ err }, 'Force lock failed');
    return respondError(`Error locking door: ${errMsg(err)}`);
  }
}
