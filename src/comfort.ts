/**
 * Comfort decision engine.
 *
 * The core idea: there is no "season" and no hardcoded mode. Each context
 * (who's here, what time it is) defines a comfort band [floor, ceiling]. The
 * controller looks at where the room actually sits and picks the action that
 * moves it into the band:
 *
 *   room above ceiling  -> COOL to ceiling
 *   room below floor    -> HEAT to floor
 *   room inside band    -> OFF
 *
 * Summer falls out for free (hot room -> cool), so does winter (cold room ->
 * heat), so does a mild day (do nothing). Outdoor weather bends the band:
 * on a 98°F day we don't let an empty apartment coast to 84°F, because the
 * room would bake and recovery on return would be brutal.
 *
 * Humidity bends the *perceived* temperature: a muggy 76°F feels worse than a
 * dry 76°F, so we target a touch cooler when the air is wet.
 *
 * This module is a pure function of its inputs — no I/O — so it is exhaustively
 * unit-testable. All the side effects (talking to SmartRent, throttling, dwell)
 * live in the poller's control loop.
 */
import type { ComfortPrefs } from './config.js';
import type { Occupancy, OutdoorWeather, ComfortDecision } from './types.js';

export interface ComfortInputs {
  occupancy: Occupancy;
  now: Date;
  indoorTempF?: number;
  indoorHumidityPct?: number;
  outdoor?: OutdoorWeather | null;
  /** For 'arriving': minutes until expected arrival. */
  etaMinutes?: number;
}

interface Band {
  /** Idle range: do nothing while the room sits inside [floorF, ceilingF]. */
  floorF: number;
  ceilingF: number;
  /** Setpoint to command when the room is too hot / too cold. */
  coolToF: number;
  heatToF: number;
}

/** True during the configured sleep window (e.g. 22:00–07:00). */
export function isSleepHour(now: Date, prefs: ComfortPrefs): boolean {
  const h = now.getHours();
  const { sleepStartHour: start, sleepEndHour: end } = prefs;
  // Window wraps midnight when start > end.
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/**
 * Perceived-temperature offset from humidity. Humidity only meaningfully adds
 * to perceived warmth once the room is already warm, so below the reference
 * temperature we return 0. Above it, every percent of RH over the reference
 * adds a small amount, capped so a freak reading can't swing the target wildly.
 */
export function humidityOffsetF(
  tempF: number,
  humidityPct: number | undefined,
  prefs: ComfortPrefs,
): number {
  if (humidityPct === undefined) return 0;
  if (tempF < prefs.humidityRefTempF) return 0;
  const over = humidityPct - prefs.humidityRefPct;
  if (over <= 0) return 0;
  return Math.min(over * prefs.humidityPerPctF, prefs.humidityCapF);
}

/**
 * The comfort band for the current context.
 *
 * 'home'/'arriving'/'sleep' use a comfort RANGE and, when they do act, drive to
 * the range's center so there's margin before the system idles again (real
 * hysteresis, no short-cycling). 'away' is a wide coast band that only ever
 * conditions to the near edge — minimal energy — and whose ceiling is pulled
 * down on hot forecast days so an empty unit doesn't bake.
 */
function bandFor(inputs: ComfortInputs, prefs: ComfortPrefs): Band {
  const { occupancy, now, outdoor } = inputs;

  if (occupancy === 'away') {
    let ceilingF = prefs.awayMaxF;
    const high = outdoor?.forecastHighF;
    if (typeof high === 'number') {
      if (high >= prefs.veryHotForecastF) ceilingF = Math.min(ceilingF, 78);
      else if (high >= prefs.hotForecastF) ceilingF = Math.min(ceilingF, 80);
    }
    return {
      floorF: prefs.awayMinF,
      ceilingF,
      coolToF: ceilingF, // only cool back to the ceiling — don't over-cool an empty home
      heatToF: prefs.awayMinF,
    };
  }

  const sleep =
    occupancy === 'sleep' || (occupancy === 'home' && isSleepHour(now, prefs));
  const lowF = sleep ? prefs.sleepLowF : prefs.homeLowF;
  const highF = sleep ? prefs.sleepHighF : prefs.homeHighF;
  const center = Math.round((lowF + highF) / 2);
  return { floorF: lowF, ceilingF: highF, coolToF: center, heatToF: center };
}

/**
 * Decide what the thermostat should do. Returns null when there isn't enough
 * information to act (no indoor reading) — the caller should hold.
 */
export function decideComfort(
  inputs: ComfortInputs,
  prefs: ComfortPrefs,
): ComfortDecision | null {
  const ts = inputs.now.toISOString();
  if (inputs.indoorTempF === undefined) return null;

  const offset = humidityOffsetF(inputs.indoorTempF, inputs.indoorHumidityPct, prefs);
  const effectiveF = inputs.indoorTempF + offset;
  const band = bandFor(inputs, prefs);
  const db = prefs.deadbandF;

  const humid = offset > 0 ? ` (feels ${effectiveF.toFixed(1)}°F at ${inputs.indoorHumidityPct}% RH)` : '';
  const out = inputs.outdoor ? `, outdoor ${inputs.outdoor.tempF.toFixed(0)}°F/high ${inputs.outdoor.forecastHighF.toFixed(0)}°F` : '';

  if (effectiveF > band.ceilingF + db) {
    return {
      mode: 'cool',
      setpointF: band.coolToF,
      reason: `room ${inputs.indoorTempF.toFixed(1)}°F${humid} > ${band.ceilingF}°F ceiling${out} → cool to ${band.coolToF}°F`,
      ts,
    };
  }
  if (effectiveF < band.floorF - db) {
    return {
      mode: 'heat',
      setpointF: band.heatToF,
      reason: `room ${inputs.indoorTempF.toFixed(1)}°F < ${band.floorF}°F floor${out} → heat to ${band.heatToF}°F`,
      ts,
    };
  }
  return {
    mode: 'off',
    reason: `room ${inputs.indoorTempF.toFixed(1)}°F${humid} within [${band.floorF}, ${band.ceilingF}]°F${out} → idle`,
    ts,
  };
}
