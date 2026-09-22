/**
 * HomeOps Configuration
 * All configuration is loaded from environment variables. Required values are
 * validated at startup; missing ones throw a clear error before anything else
 * tries to run.
 */

import type { ThermostatMode } from './types.js';

const THERMOSTAT_MODES: readonly ThermostatMode[] = ['heat', 'cool', 'auto'] as const;

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
  /** Mode used for a /thermostat set that doesn't specify one. */
  defaultThermostatMode: ThermostatMode;
  throttles: {
    unlockMinMs: number;
    lockMinMs: number;
    autolockAttemptMinMs: number;
  };
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

    // PREHEAT_MODE is still read for backwards compatibility with existing envs.
    defaultThermostatMode: enumEnv<ThermostatMode>(
      'DEFAULT_THERMOSTAT_MODE',
      THERMOSTAT_MODES,
      enumEnv<ThermostatMode>('PREHEAT_MODE', THERMOSTAT_MODES, 'heat'),
    ),

    throttles: {
      unlockMinMs: 2 * 60 * 1000,
      lockMinMs: 30 * 1000,
      autolockAttemptMinMs: 2 * 60 * 1000,
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
