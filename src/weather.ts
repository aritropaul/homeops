/**
 * Outdoor weather via Open-Meteo (no API key required).
 *
 * The comfort engine uses outdoor conditions for two things:
 *   1. Anticipation — on /leave, how far we let the room coast depends on how
 *      hot it's forecast to get. A 98°F day means a tighter away ceiling so the
 *      room doesn't bake and so recovery on return is feasible.
 *   2. Direction — which way the room will drift when the system is off.
 *
 * Failures here are non-fatal: the engine still works off the indoor reading
 * alone, it just loses the anticipatory layer. We cache so a 30s control loop
 * doesn't hammer the API.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import type { OutdoorWeather } from './types.js';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // Open-Meteo refreshes ~every 15 min.

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

let cached: OutdoorWeather | null = null;
let inflight: Promise<OutdoorWeather | null> | null = null;

function configured(): boolean {
  return (
    typeof config.location.latitude === 'number' &&
    typeof config.location.longitude === 'number'
  );
}

async function fetchWeather(): Promise<OutdoorWeather | null> {
  const { latitude, longitude } = config.location;
  const url =
    `${BASE_URL}?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'HomeOps/1.0.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo error: ${response.status}`);
  }

  const data = (await response.json()) as OpenMeteoResponse;
  const tempF = data.current?.temperature_2m;
  const humidityPct = data.current?.relative_humidity_2m;
  const forecastHighF = data.daily?.temperature_2m_max?.[0];
  const forecastLowF = data.daily?.temperature_2m_min?.[0];

  // A response missing the current temperature is unusable.
  if (typeof tempF !== 'number') {
    throw new Error('Open-Meteo response missing current temperature');
  }

  return {
    tempF,
    humidityPct: typeof humidityPct === 'number' ? humidityPct : 50,
    forecastHighF: typeof forecastHighF === 'number' ? forecastHighF : tempF,
    forecastLowF: typeof forecastLowF === 'number' ? forecastLowF : tempF,
    ts: new Date().toISOString(),
  };
}

/**
 * Returns current outdoor weather, cached for CACHE_TTL_MS. Returns null when
 * location is unconfigured or the API is unreachable — callers must treat
 * weather as optional.
 */
export async function getWeather(): Promise<OutdoorWeather | null> {
  if (!configured()) return null;

  if (cached) {
    const age = Date.now() - new Date(cached.ts).getTime();
    if (age < CACHE_TTL_MS) return cached;
  }

  // Single-flight: a burst of control ticks shares one in-flight request.
  if (inflight) return inflight;
  inflight = fetchWeather()
    .then((w) => {
      if (w) cached = w;
      return w;
    })
    .catch((err) => {
      logger.warn({ err }, 'Weather fetch failed, using stale/none');
      return cached; // fall back to last good reading if we have one
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test/diagnostic helper. */
export function __resetWeatherCache(): void {
  cached = null;
  inflight = null;
}
