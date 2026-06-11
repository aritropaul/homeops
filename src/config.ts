/**
 * HomeOps Configuration
 * All configuration is loaded from environment variables. Required values are
 * validated at startup; missing ones throw a clear error before anything else
 * tries to run.
 */

type PreheatMode = 'heat' | 'cool' | 'auto';
const PREHEAT_MODES: readonly PreheatMode[] = ['heat', 'cool', 'auto'] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

function optionalEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function optionalEnvFloat(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

/** Optional float that stays undefined when unset (e.g. location coords). */
function optionalEnvFloatOrUndef(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

function enumEnv<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = (process.env[name] || defaultValue).toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid value for ${name}: ${value}. Must be one of: ${allowed.join(', ')}`,
    );
  }
  return value;
}

/**
 * Tunables for the comfort engine. The whole point is that there is no season
 * or mode here — just the comfort band per context and how the room's
 * perceived temperature is computed. The engine picks heat/cool/off itself.
 */
export type ComfortPrefs = {
  /**
   * Comfort range when home and awake. The engine idles inside [low, high] and
   * only acts when the room leaves it — then it drives to the range's center,
   * so a room drifting 2° cool in summer never trips the heater.
   */
  homeLowF: number;
  homeHighF: number;
  /** Comfort range during the sleep window (cooler for sleep). */
  sleepLowF: number;
  sleepHighF: number;
  /** Away coast band — engine only acts at these extremes while you're out. */
  awayMaxF: number;
  awayMinF: number;
  /** Small anti-chatter margin beyond the band edge before acting. */
  deadbandF: number;
  /** Sleep window, 24h local clock. Wraps midnight when start > end. */
  sleepStartHour: number;
  sleepEndHour: number;
  /** Humidity → perceived-temperature model. */
  humidityRefTempF: number;
  humidityRefPct: number;
  humidityPerPctF: number;
  humidityCapF: number;
  /** Forecast highs at/above these tighten the away ceiling. */
  hotForecastF: number;
  veryHotForecastF: number;
  /**
   * Don't fight the weather: suppress heating when the day's high is at/above
   * hotForecastF, and suppress cooling when it's at/below coldForecastF — just
   * idle and let the room drift instead of running the opposite system.
   */
  coldForecastF: number;
  /** Min spacing between engine commands to B2 (anti-short-cycle), minutes. */
  controlMinMinutes: number;
  /** How long a manual /thermostat pin suspends the engine, minutes. */
  overrideTtlMinutes: number;
};

export type Config = {
  port: number;
  host: string;
  logLevel: string;
  homeopsKey: string;
  smartrent: { email: string; password: string; unitId: string };
  devices: {
    lockId: string;
    thermostatB1Id: string;
    thermostatB2Id: string;
    thermostatB3Id: string;
  };
  redis: { url: string; token: string };
  pollSeconds: number;
  autolockMinutes: number;
  preheat: {
    b1TargetF: number;
    b2TargetF: number;
    b3TargetF: number;
    mode: PreheatMode;
  };
  eco: {
    enabled: boolean;
    b1TargetF: number;
    b2TargetF: number;
    b3TargetF: number;
  };
  throttles: {
    unlockMinMs: number;
    lockMinMs: number;
    preheatMinMs: number;
    autolockAttemptMinMs: number;
  };
  /** Weather location for the comfort engine. Undefined = weather disabled. */
  location: { latitude?: number; longitude?: number };
  /** When true, the engine autonomously holds B2 to the comfort band each poll. */
  comfortAuto: boolean;
  comfort: ComfortPrefs;
};

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    port: optionalEnvInt('PORT', 3000),
    host: optionalEnv('HOST', '0.0.0.0'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),

    homeopsKey: requireEnv('HOMEOPS_KEY'),

    smartrent: {
      email: requireEnv('SMARTRENT_EMAIL'),
      password: requireEnv('SMARTRENT_PASSWORD'),
      unitId: requireEnv('SMARTRENT_UNIT_ID'),
    },

    devices: {
      lockId: requireEnv('LOCK_ID'),
      thermostatB1Id: requireEnv('THERMOSTAT_B1_ID'),
      thermostatB2Id: requireEnv('THERMOSTAT_B2_ID'),
      thermostatB3Id: requireEnv('THERMOSTAT_B3_ID'),
    },

    redis: {
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    },

    pollSeconds: optionalEnvInt('POLL_SECONDS', 30),
    autolockMinutes: optionalEnvInt('AUTOLOCK_MINUTES', 10),

    preheat: {
      b1TargetF: optionalEnvInt('PREHEAT_TARGET_B1_F', 70),
      b2TargetF: optionalEnvInt('PREHEAT_TARGET_B2_F', 70),
      b3TargetF: optionalEnvInt('PREHEAT_TARGET_B3_F', 70),
      mode: enumEnv<PreheatMode>('PREHEAT_MODE', PREHEAT_MODES, 'heat'),
    },

    eco: {
      enabled: optionalEnvBool('ENABLE_ECO_ON_LEAVE', false),
      b1TargetF: optionalEnvInt('ECO_TARGET_B1_F', 65),
      b2TargetF: optionalEnvInt('ECO_TARGET_B2_F', 65),
      b3TargetF: optionalEnvInt('ECO_TARGET_B3_F', 65),
    },

    throttles: {
      unlockMinMs: 2 * 60 * 1000,
      lockMinMs: 30 * 1000,
      preheatMinMs: 10 * 60 * 1000,
      autolockAttemptMinMs: 2 * 60 * 1000,
    },

    location: {
      latitude: optionalEnvFloatOrUndef('LATITUDE'),
      longitude: optionalEnvFloatOrUndef('LONGITUDE'),
    },

    comfortAuto: optionalEnvBool('ENABLE_COMFORT_AUTO', true),

    comfort: {
      homeLowF: optionalEnvInt('COMFORT_HOME_LOW_F', 68),
      homeHighF: optionalEnvInt('COMFORT_HOME_HIGH_F', 72),
      sleepLowF: optionalEnvInt('COMFORT_SLEEP_LOW_F', 65),
      sleepHighF: optionalEnvInt('COMFORT_SLEEP_HIGH_F', 70),
      awayMaxF: optionalEnvInt('COMFORT_AWAY_MAX_F', 82),
      awayMinF: optionalEnvInt('COMFORT_AWAY_MIN_F', 60),
      deadbandF: optionalEnvFloat('COMFORT_DEADBAND_F', 0.5),
      sleepStartHour: optionalEnvInt('COMFORT_SLEEP_START_HOUR', 22),
      sleepEndHour: optionalEnvInt('COMFORT_SLEEP_END_HOUR', 7),
      humidityRefTempF: optionalEnvInt('COMFORT_HUMIDITY_REF_TEMP_F', 74),
      humidityRefPct: optionalEnvInt('COMFORT_HUMIDITY_REF_PCT', 50),
      humidityPerPctF: optionalEnvFloat('COMFORT_HUMIDITY_PER_PCT_F', 0.1),
      humidityCapF: optionalEnvFloat('COMFORT_HUMIDITY_CAP_F', 3),
      hotForecastF: optionalEnvInt('COMFORT_HOT_FORECAST_F', 90),
      veryHotForecastF: optionalEnvInt('COMFORT_VERY_HOT_FORECAST_F', 95),
      coldForecastF: optionalEnvInt('COMFORT_COLD_FORECAST_F', 55),
      controlMinMinutes: optionalEnvInt('COMFORT_CONTROL_MIN_MINUTES', 5),
      overrideTtlMinutes: optionalEnvInt('COMFORT_OVERRIDE_TTL_MINUTES', 120),
    },
  };
  return cachedConfig;
}

/**
 * Eagerly-resolved config proxy. Reading any property triggers loadConfig().
 * Existing call sites that do `config.port` continue to work; tests that want
 * to bypass env can call `__resetConfigForTests` (see end of file).
 */
export const config: Config = new Proxy({} as Config, {
  get(_target, prop) {
    const c = loadConfig();
    return c[prop as keyof Config];
  },
});

/** For tests only — clears the cached config so the next access reloads env. */
export function __resetConfigForTests(): void {
  cachedConfig = null;
}
