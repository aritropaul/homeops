import { describe, it, expect } from 'vitest';
import { decideComfort, humidityOffsetF, isSleepHour } from '../src/comfort.js';
import type { ComfortPrefs } from '../src/config.js';
import type { OutdoorWeather } from '../src/types.js';

const prefs: ComfortPrefs = {
  homeLowF: 70,
  homeHighF: 74,
  sleepLowF: 65,
  sleepHighF: 70,
  awayMaxF: 82,
  awayMinF: 60,
  deadbandF: 0.5,
  sleepStartHour: 22,
  sleepEndHour: 7,
  humidityRefTempF: 74,
  humidityRefPct: 50,
  humidityPerPctF: 0.1,
  humidityCapF: 3,
  hotForecastF: 90,
  veryHotForecastF: 95,
  controlMinMinutes: 5,
  overrideTtlMinutes: 120,
};

// Local-time strings (no 'Z') so getHours() is deterministic across timezones.
const DAY = new Date('2026-06-11T14:00:00');
const NIGHT = new Date('2026-06-11T23:30:00');

function weather(tempF: number, forecastHighF: number): OutdoorWeather {
  return { tempF, humidityPct: 50, forecastHighF, forecastLowF: 60, ts: DAY.toISOString() };
}

describe('isSleepHour', () => {
  it('is true inside the wrapping 22:00–07:00 window', () => {
    expect(isSleepHour(new Date('2026-06-11T23:30:00'), prefs)).toBe(true);
    expect(isSleepHour(new Date('2026-06-11T06:00:00'), prefs)).toBe(true);
  });
  it('is false during the day', () => {
    expect(isSleepHour(new Date('2026-06-11T07:30:00'), prefs)).toBe(false);
    expect(isSleepHour(new Date('2026-06-11T14:00:00'), prefs)).toBe(false);
  });
});

describe('humidityOffsetF', () => {
  it('is zero below the reference temperature', () => {
    expect(humidityOffsetF(70, 100, prefs)).toBe(0);
  });
  it('is zero at/below the reference humidity', () => {
    expect(humidityOffsetF(80, 50, prefs)).toBe(0);
    expect(humidityOffsetF(80, 40, prefs)).toBe(0);
  });
  it('scales with humidity over the reference', () => {
    expect(humidityOffsetF(80, 70, prefs)).toBeCloseTo(2, 5); // 20% * 0.1
  });
  it('is capped', () => {
    expect(humidityOffsetF(80, 100, prefs)).toBe(3); // 50% * 0.1 = 5, capped at 3
  });
});

describe('decideComfort — no season, the room decides', () => {
  it('cools a hot room to the comfort center when home', () => {
    const d = decideComfort({ occupancy: 'home', now: DAY, indoorTempF: 80 }, prefs);
    expect(d?.mode).toBe('cool');
    expect(d?.setpointF).toBe(72); // center of [70, 74]
  });

  it('heats a cold room to the comfort center when home', () => {
    const d = decideComfort({ occupancy: 'home', now: DAY, indoorTempF: 64 }, prefs);
    expect(d?.mode).toBe('heat');
    expect(d?.setpointF).toBe(72);
  });

  it('idles anywhere inside the comfort range', () => {
    expect(decideComfort({ occupancy: 'home', now: DAY, indoorTempF: 71 }, prefs)?.mode).toBe('off');
    expect(decideComfort({ occupancy: 'home', now: DAY, indoorTempF: 73 }, prefs)?.mode).toBe('off');
  });

  it('does NOT heat a slightly-cool room in summer (the bug the range fixes)', () => {
    // 70°F on a hot day must idle, never trip the heater.
    const d = decideComfort(
      { occupancy: 'home', now: DAY, indoorTempF: 70, outdoor: weather(95, 98) },
      prefs,
    );
    expect(d?.mode).toBe('off');
  });

  it('returns null with no indoor reading', () => {
    expect(decideComfort({ occupancy: 'home', now: DAY }, prefs)).toBeNull();
  });

  it('uses the cooler sleep range at night', () => {
    // 72°F idles during the day (range 70–74) but cools toward the sleep center at night.
    expect(decideComfort({ occupancy: 'home', now: DAY, indoorTempF: 72 }, prefs)?.mode).toBe('off');
    const night = decideComfort({ occupancy: 'home', now: NIGHT, indoorTempF: 72 }, prefs);
    expect(night?.mode).toBe('cool');
    expect(night?.setpointF).toBe(68); // center of [65, 70], rounded
  });

  it('uses the sleep range for explicit sleep intent regardless of clock', () => {
    const d = decideComfort({ occupancy: 'sleep', now: DAY, indoorTempF: 72 }, prefs);
    expect(d?.mode).toBe('cool');
    expect(d?.setpointF).toBe(68);
  });
});

describe('decideComfort — away coast band is weather-aware', () => {
  it('lets the room coast on a mild day', () => {
    const d = decideComfort(
      { occupancy: 'away', now: DAY, indoorTempF: 81, outdoor: weather(70, 72) },
      prefs,
    );
    expect(d?.mode).toBe('off'); // 81 within [60, 82]
  });

  it('tightens the ceiling and cools on a very hot forecast', () => {
    const d = decideComfort(
      { occupancy: 'away', now: DAY, indoorTempF: 81, outdoor: weather(95, 98) },
      prefs,
    );
    expect(d?.mode).toBe('cool'); // ceiling pulled to 78, 81 > 79.5
    expect(d?.setpointF).toBe(78);
  });

  it('heats only at the away floor', () => {
    const d = decideComfort(
      { occupancy: 'away', now: DAY, indoorTempF: 57, outdoor: weather(30, 35) },
      prefs,
    );
    expect(d?.mode).toBe('heat');
    expect(d?.setpointF).toBe(60);
  });
});

describe('decideComfort — humidity nudges perceived temperature', () => {
  it('a muggy room cools where the same dry room would idle', () => {
    // 74°F sits on the ceiling: dry it idles (74 ≤ 74.5), but at 95% RH it
    // feels like ~77°F and the engine cools.
    const dry = decideComfort(
      { occupancy: 'home', now: DAY, indoorTempF: 74, indoorHumidityPct: 50 },
      prefs,
    );
    const humid = decideComfort(
      { occupancy: 'home', now: DAY, indoorTempF: 74, indoorHumidityPct: 95 },
      prefs,
    );
    expect(dry?.mode).toBe('off');
    expect(humid?.mode).toBe('cool');
  });
});
