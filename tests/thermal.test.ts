import { describe, it, expect } from 'vitest';
import { estimateRates, minutesToTarget, shouldPreconditionNow } from '../src/thermal.js';
import type { ThermalSample } from '../src/types.js';

function sample(minute: number, indoorF: number, mode: ThermalSample['mode']): ThermalSample {
  return { ts: new Date(2026, 5, 11, 12, minute, 0).toISOString(), indoorF, mode };
}

describe('estimateRates', () => {
  it('falls back to seeded defaults with no data', () => {
    const r = estimateRates([]);
    expect(r.coolRateFPerMin).toBeCloseTo(0.35, 5);
    expect(r.heatRateFPerMin).toBeCloseTo(0.3, 5);
    expect(r.samples).toBe(0);
  });

  it('learns the cooling rate from consecutive cooling samples', () => {
    // 80 -> 79 -> 78 over two 2-minute intervals = 0.5 °F/min.
    const r = estimateRates([
      sample(0, 80, 'cool'),
      sample(2, 79, 'cool'),
      sample(4, 78, 'cool'),
    ]);
    expect(r.coolRateFPerMin).toBeCloseTo(0.5, 5);
    expect(r.samples).toBe(2);
  });

  it('ignores intervals where the system was not actively cooling', () => {
    // mode off: passive drift must not be counted as a cooling rate.
    const r = estimateRates([sample(0, 80, 'off'), sample(2, 79, 'off')]);
    expect(r.coolRateFPerMin).toBeCloseTo(0.35, 5); // unchanged default
    expect(r.samples).toBe(0);
  });

  it('ignores long gaps between samples', () => {
    const r = estimateRates([sample(0, 80, 'cool'), sample(30, 70, 'cool')]);
    expect(r.samples).toBe(0); // 30-min gap exceeds MAX_GAP_MINUTES
  });
});

describe('minutesToTarget', () => {
  const rates = { coolRateFPerMin: 0.4, heatRateFPerMin: 0.3, samples: 10 };

  it('computes cooling lead time plus buffer', () => {
    // (80 - 72) / 0.4 = 20, + 3 buffer = 23
    expect(minutesToTarget(80, 72, 'cool', rates)).toBe(23);
  });

  it('is zero when already past the target', () => {
    expect(minutesToTarget(70, 72, 'cool', rates)).toBe(0);
  });
});

describe('shouldPreconditionNow', () => {
  const rates = { coolRateFPerMin: 0.4, heatRateFPerMin: 0.3, samples: 10 };

  it('starts once the ETA is within the needed lead time', () => {
    expect(shouldPreconditionNow(20, 80, 72, 'cool', rates)).toBe(true); // need 23, eta 20
  });

  it('waits when there is still plenty of time', () => {
    expect(shouldPreconditionNow(40, 80, 72, 'cool', rates)).toBe(false);
  });
});
