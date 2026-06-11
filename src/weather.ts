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
import https from 'node:https';
import { Resolver, type LookupOptions, type LookupAddress } from 'node:dns';
import { config } from './config.js';
import { logger } from './logger.js';
import type { OutdoorWeather } from './types.js';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // Open-Meteo refreshes ~every 15 min.
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Bounded backoff with jitter, like the SmartRent client. Fly's resolver
// intermittently returns EAI_AGAIN for external hosts; a single attempt loses,
// retries win (this is exactly why SmartRent survives on the same machine).
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
}

/**
 * Fly's internal DNS forwarder cannot resolve api.open-meteo.com (its
 * authoritative DNS is Hetzner-hosted) and returns EAI_AGAIN forever, so
 * getaddrinfo — and therefore global fetch — never succeeds. Resolve through
 * public DNS via c-ares instead, then hand the IP to the request as a custom
 * lookup. The hostname is unchanged, so TLS SNI and certificate validation
 * still happen against api.open-meteo.com.
 */
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);

function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  resolver.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || addresses.length === 0) {
      callback(err ?? new Error(`no A record for ${hostname}`), '', 4);
      return;
    }
    if (options.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 })),
      );
    } else {
      callback(null, addresses[0], 4);
    }
  });
}

function httpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: publicLookup,
        headers: { Accept: 'application/json', 'User-Agent': 'HomeOps/1.0.0' },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          reject(new Error(`Open-Meteo error: ${status}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Open-Meteo request timed out')));
    req.on('error', reject);
  });
}

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

async function fetchWeatherOnce(): Promise<OutdoorWeather> {
  const { latitude, longitude } = config.location;
  const url =
    `${BASE_URL}?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;

  const data = (await httpsGetJson(url)) as OpenMeteoResponse;
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

async function fetchWeather(): Promise<OutdoorWeather> {
  let lastErr: unknown;
  // The request is an idempotent GET, so retry on any transient failure.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchWeatherOnce();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('weather fetch failed after retries');
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
      cached = w;
      return w as OutdoorWeather | null;
    })
    .catch((err) => {
      logger.warn({ err }, 'Weather fetch failed after retries, using stale/none');
      return cached; // fall back to last good reading if we have one
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Non-blocking accessor for read paths like /status: returns the last known
 * reading immediately (possibly stale or null) and kicks off a background
 * refresh if it's stale, so the endpoint never waits on a retry storm.
 */
export function getCachedWeather(): OutdoorWeather | null {
  const stale = !cached || Date.now() - new Date(cached.ts).getTime() >= CACHE_TTL_MS;
  if (configured() && stale) void getWeather().catch(() => {});
  return cached;
}

/** Test/diagnostic helper. */
export function __resetWeatherCache(): void {
  cached = null;
  inflight = null;
}
