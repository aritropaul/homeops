/**
 * Learned thermal model for B2.
 *
 * Every poll tick we record a sample: (time, indoor temp, mode, setpoint,
 * outdoor temp). From the history we estimate how fast the room actually
 * changes temperature while the system is actively heating or cooling. That
 * rate drives pre-conditioning: given "I'll be home in 25 minutes", how many
 * minutes of lead time does the room need to reach the target?
 *
 * This is deliberately simple and self-correcting: an exponential view of
 * observed rates, seeded with a sane default so it works on a cold start and
 * refines as real data accumulates. We never trust a single noisy reading —
 * rates are clamped to physically plausible bounds.
 */
import type { ThermalSample } from './types.js';

// Plausible bounds for a single room's HVAC, °F per minute.
const MIN_RATE = 0.05;
const MAX_RATE = 1.0;
const DEFAULT_COOL_RATE = 0.35;
const DEFAULT_HEAT_RATE = 0.30;
// Ignore gaps longer than this between samples — the room may have been
// untracked (process restart) and the delta is meaningless.
const MAX_GAP_MINUTES = 15;
const LEAD_BUFFER_MINUTES = 3;

export interface RateEstimate {
  coolRateFPerMin: number;
  heatRateFPerMin: number;
  samples: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Estimate active heating/cooling rates from the sample history. Looks at
 * consecutive samples where the system was actively driving in one direction
 * and the temperature moved the expected way, then averages the per-minute
 * rate. Falls back to seeded defaults when there isn't enough signal.
 */
export function estimateRates(samples: ThermalSample[]): RateEstimate {
  const coolRates: number[] = [];
  const heatRates: number[] = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev.indoorF === undefined || cur.indoorF === undefined) continue;

    const minutes = (new Date(cur.ts).getTime() - new Date(prev.ts).getTime()) / 60000;
    if (minutes <= 0 || minutes > MAX_GAP_MINUTES) continue;

    const delta = cur.indoorF - prev.indoorF;

    // Cooling: mode cool across the interval, temperature dropped.
    if (prev.mode === 'cool' && cur.mode === 'cool' && delta < 0) {
      coolRates.push(-delta / minutes);
    }
    // Heating: mode heat across the interval, temperature rose.
    if (prev.mode === 'heat' && cur.mode === 'heat' && delta > 0) {
      heatRates.push(delta / minutes);
    }
  }

  const avg = (xs: number[], fallback: number): number =>
    xs.length === 0 ? fallback : clamp(xs.reduce((a, b) => a + b, 0) / xs.length, MIN_RATE, MAX_RATE);

  return {
    coolRateFPerMin: avg(coolRates, DEFAULT_COOL_RATE),
    heatRateFPerMin: avg(heatRates, DEFAULT_HEAT_RATE),
    samples: coolRates.length + heatRates.length,
  };
}

/**
 * Minutes of HVAC runtime needed to move the room from `currentF` to `targetF`
 * in the given mode, plus a small safety buffer. Returns 0 when the room is
 * already past the target in the helpful direction.
 */
export function minutesToTarget(
  currentF: number,
  targetF: number,
  mode: 'heat' | 'cool',
  rates: RateEstimate,
): number {
  const gap = mode === 'cool' ? currentF - targetF : targetF - currentF;
  if (gap <= 0) return 0;
  const rate = mode === 'cool' ? rates.coolRateFPerMin : rates.heatRateFPerMin;
  return Math.ceil(gap / rate) + LEAD_BUFFER_MINUTES;
}

/**
 * Should pre-conditioning start now, given the ETA? True once the remaining
 * time-to-arrival has shrunk to the lead time the room needs.
 */
export function shouldPreconditionNow(
  etaMinutes: number,
  currentF: number,
  targetF: number,
  mode: 'heat' | 'cool',
  rates: RateEstimate,
): boolean {
  return etaMinutes <= minutesToTarget(currentF, targetF, mode, rates);
}
