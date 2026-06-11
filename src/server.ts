/**
 * HomeOps API Server
 * Fastify server with all endpoints for iOS Shortcuts.
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { getStore } from './store.js';
import { startPoller, isPollerRunning, isSocketConnected } from './poller.js';
import { getCachedWeather } from './weather.js';
import {
  handleArrive,
  handleLeave,
  handleLock,
  handleUnlock,
  handlePreheat,
  handleSetThermostat,
  handleThermostatOff,
  handleForceLock,
  handleForceUnlock,
  handleArriving,
  handleSleep,
} from './actions.js';
import type { StatusResponse } from './types.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_MAX_IPS = 10_000; // hard cap on map size

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  record.count++;
  return true;
}

// Periodic sweep of expired entries; also evict oldest if map gets too large.
function startRateLimitSweep(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap) {
      if (now > record.resetAt) rateLimitMap.delete(ip);
    }
    if (rateLimitMap.size > RATE_LIMIT_MAX_IPS) {
      // Map preserves insertion order — drop oldest entries down to half the cap.
      const drop = rateLimitMap.size - RATE_LIMIT_MAX_IPS / 2;
      let i = 0;
      for (const ip of rateLimitMap.keys()) {
        if (i++ >= drop) break;
        rateLimitMap.delete(ip);
      }
    }
  }, RATE_LIMIT_WINDOW_MS).unref();
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers['x-homeops-key'];
  if (!key || key !== config.homeopsKey) {
    logger.warn({ reqId: request.id, ip: request.ip, path: request.url }, 'Unauthorized');
    return reply.status(401).send({ ok: false, error: 'Unauthorized' });
  }
  if (!checkRateLimit(request.ip)) {
    logger.warn({ reqId: request.id, ip: request.ip, path: request.url }, 'Rate limited');
    return reply.status(429).send({ ok: false, error: 'Too many requests' });
  }
}

export function createServer(): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) || randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        reqId: request.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
        ip: request.ip,
      },
      'request',
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Public endpoints — no auth
  // ──────────────────────────────────────────────────────────────────────────

  // Liveness: process is alive. Used by Fly's health check. Never returns 5xx
  // unless the process can't respond at all.
  app.get('/health/live', async (_request, reply) => {
    reply.status(200).send({ ok: true });
  });

  // Readiness: can we actually serve traffic? Returns 503 when degraded.
  // No internal error details exposed here.
  app.get('/health/ready', async (_request, reply) => {
    const store = getStore();
    const state = await store.getState();
    const lastPollTs = state.lastPollTs ? new Date(state.lastPollTs).getTime() : 0;
    const pollAge = Date.now() - lastPollTs;
    const degraded = pollAge > 2 * 60 * 1000 || !isPollerRunning();

    reply.status(degraded ? 503 : 200).send({ ok: !degraded, degraded });
  });

  // Back-compat for older Fly check / Shortcuts pointed at /health.
  app.get('/health', async (_request, reply) => {
    reply.status(200).send({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Protected endpoints
  // ──────────────────────────────────────────────────────────────────────────

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', authenticate);

    protectedRoutes.post('/arrive', async (_req, reply) => {
      reply.status(200).send(await handleArrive());
    });

    protectedRoutes.post('/leave', async (_req, reply) => {
      reply.status(200).send(await handleLeave());
    });

    protectedRoutes.post('/lock', async (_req, reply) => {
      reply.status(200).send(await handleLock());
    });

    protectedRoutes.post('/unlock', async (_req, reply) => {
      reply.status(200).send(await handleUnlock());
    });

    protectedRoutes.post('/preheat', async (_req, reply) => {
      reply.status(200).send(await handlePreheat());
    });

    // "I'll be home in N minutes" — pre-condition B2 to land on target on arrival.
    protectedRoutes.post<{ Params: { eta: string } }>(
      '/arriving/:eta',
      async (request, reply) => {
        const eta = parseInt(request.params.eta, 10);
        if (isNaN(eta)) {
          return reply.status(400).send({ ok: false, error: 'Invalid ETA' });
        }
        const response = await handleArriving(eta);
        reply.status(response.ok ? 200 : 400).send(response);
      },
    );

    // Switch to the cooler night comfort target.
    protectedRoutes.post('/sleep', async (_req, reply) => {
      reply.status(200).send(await handleSleep());
    });

    protectedRoutes.post<{
      Params: { name: string; temp: string };
      Querystring: { mode?: string };
    }>('/thermostat/:name/:temp', async (request, reply) => {
      const { name, temp } = request.params;
      const { mode } = request.query;
      const tempNum = parseInt(temp, 10);
      if (isNaN(tempNum)) {
        return reply.status(400).send({ ok: false, error: 'Invalid temperature' });
      }
      const response = await handleSetThermostat(name, tempNum, mode);
      reply.status(response.ok ? 200 : 400).send(response);
    });

    protectedRoutes.post<{ Params: { name: string } }>(
      '/thermostat/:name/off',
      async (request, reply) => {
        const response = await handleThermostatOff(request.params.name);
        reply.status(response.ok ? 200 : 400).send(response);
      },
    );

    protectedRoutes.post('/lock/force', async (_req, reply) => {
      reply.status(200).send(await handleForceLock());
    });

    protectedRoutes.post('/unlock/force', async (_req, reply) => {
      reply.status(200).send(await handleForceUnlock());
    });

    // Authenticated status endpoint — exposes the detail /health/ready hides.
    protectedRoutes.get('/status', async (_req, reply) => {
      const store = getStore();
      const state = await store.getState();
      const response: StatusResponse = {
        devices: state.devices,
        lockTracking: state.lockTracking,
        throttles: state.throttles,
        lastPollTs: state.lastPollTs,
        lastErrorTs: state.lastErrorTs,
      };
      // Surface lastError + socket state here, not on /health. Also the comfort
      // engine's view: current intent, any manual pin, the last decision + why,
      // and the outdoor weather it's reacting to.
      reply.status(200).send({
        ...response,
        occupancy: state.occupancy,
        manualOverride: state.manualOverride,
        comfort: state.lastComfortDecision,
        weather: getCachedWeather(),
        lastError: state.lastError,
        socketConnected: isSocketConnected(),
      });
    });
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, reqId: request.id, path: request.url }, 'Request error');
    reply.status(500).send({ ok: false, error: 'Internal server error' });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ ok: false, error: 'Not found' });
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = createServer();
  startPoller();
  startRateLimitSweep();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'Server started');
  return app;
}
