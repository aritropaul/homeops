/**
 * Structured logging with pino.
 * Redact paths are wildcards so nested secrets are caught too.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      '*.password',
      '*.access_token',
      '*.accessToken',
      '*.refresh_token',
      '*.refreshToken',
      '*.token',
      '*.Authorization',
      '*.authorization',
      'password',
      'access_token',
      'accessToken',
      'refresh_token',
      'refreshToken',
      'token',
      'SMARTRENT_PASSWORD',
      'UPSTASH_REDIS_REST_TOKEN',
      'HOMEOPS_KEY',
      'headers.authorization',
      'headers["x-homeops-key"]',
      'config.smartrent.password',
      'config.redis.token',
      'config.homeopsKey',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
