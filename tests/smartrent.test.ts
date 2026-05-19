import { describe, it, expect } from 'vitest';
import { parseLockState, parseThermostatState } from '../src/smartrent.js';
import type { SmartRentDevice } from '../src/types.js';

function makeDevice(
  type: string,
  attrs: Array<{ name: string; state: string; pending_state?: string | null }>,
): SmartRentDevice {
  return {
    id: 1,
    name: 'test',
    type,
    attributes: attrs.map((a) => ({
      name: a.name,
      state: a.state,
      pending_state: a.pending_state ?? null,
      last_read_at: null,
      pending_state_requested_at: null,
    })),
    battery_level: 80,
    battery_powered: true,
    online: true,
    model: 'test',
    primary_lock: true,
  };
}

describe('parseLockState', () => {
  it('returns "locked" when locked=true', () => {
    expect(parseLockState(makeDevice('entry_control', [{ name: 'locked', state: 'true' }]))).toBe(
      'locked',
    );
  });

  it('returns "unlocked" when locked=false', () => {
    expect(parseLockState(makeDevice('entry_control', [{ name: 'locked', state: 'false' }]))).toBe(
      'unlocked',
    );
  });

  it('returns "unknown" when locked attribute missing', () => {
    expect(parseLockState(makeDevice('entry_control', []))).toBe('unknown');
  });

  it('returns "unknown" for garbage state values', () => {
    expect(parseLockState(makeDevice('entry_control', [{ name: 'locked', state: 'pending' }]))).toBe(
      'unknown',
    );
  });
});

describe('parseThermostatState', () => {
  it('parses heat mode with heating setpoint as target', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'heat' },
        { name: 'current_temp', state: '70' },
        { name: 'heating_setpoint', state: '72' },
        { name: 'cooling_setpoint', state: '78' },
        { name: 'current_humidity', state: '45' },
      ]),
    );
    expect(result.mode).toBe('heat');
    expect(result.currentTempF).toBe(70);
    expect(result.targetTempF).toBe(72);
    expect(result.humidityPct).toBe(45);
  });

  it('parses cool mode with cooling setpoint as target', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'cool' },
        { name: 'heating_setpoint', state: '72' },
        { name: 'cooling_setpoint', state: '76' },
      ]),
    );
    expect(result.mode).toBe('cool');
    expect(result.targetTempF).toBe(76);
  });

  it('treats aux_heat as heat', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'aux_heat' },
        { name: 'heating_setpoint', state: '70' },
      ]),
    );
    expect(result.mode).toBe('heat');
  });

  it('returns unknown mode for missing/garbage values', () => {
    expect(parseThermostatState(makeDevice('thermostat', [])).mode).toBe('unknown');
    expect(
      parseThermostatState(makeDevice('thermostat', [{ name: 'mode', state: 'lol' }])).mode,
    ).toBe('unknown');
  });

  it('captures fan_mode when valid', () => {
    expect(
      parseThermostatState(makeDevice('thermostat', [{ name: 'fan_mode', state: 'on' }])).fanMode,
    ).toBe('on');
    expect(
      parseThermostatState(makeDevice('thermostat', [{ name: 'fan_mode', state: 'auto' }])).fanMode,
    ).toBe('auto');
  });

  it('omits fan_mode when value is unrecognized', () => {
    expect(
      parseThermostatState(makeDevice('thermostat', [{ name: 'fan_mode', state: 'circulate' }]))
        .fanMode,
    ).toBeUndefined();
  });

  it('exposes operating_state passthrough', () => {
    expect(
      parseThermostatState(
        makeDevice('thermostat', [{ name: 'operating_state', state: 'heating' }]),
      ).operatingState,
    ).toBe('heating');
  });

  it('surfaces pending mode separately from confirmed mode', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'heat', pending_state: 'cool' },
      ]),
    );
    expect(result.mode).toBe('heat');
    expect(result.pendingMode).toBe('cool');
  });

  it('surfaces pending setpoint matching the in-flight mode', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'heat', pending_state: 'cool' },
        { name: 'heating_setpoint', state: '70' },
        { name: 'cooling_setpoint', state: '70', pending_state: '69' },
      ]),
    );
    expect(result.mode).toBe('heat');
    expect(result.targetTempF).toBe(70);
    expect(result.pendingMode).toBe('cool');
    expect(result.pendingTargetTempF).toBe(69);
  });

  it('leaves pending fields undefined when nothing is in flight', () => {
    const result = parseThermostatState(
      makeDevice('thermostat', [
        { name: 'mode', state: 'heat' },
        { name: 'heating_setpoint', state: '70' },
      ]),
    );
    expect(result.pendingMode).toBeUndefined();
    expect(result.pendingTargetTempF).toBeUndefined();
  });
});
