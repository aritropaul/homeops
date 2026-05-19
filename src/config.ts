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
