/**
 * SmartRent API Client
 * Handles authentication (incl. refresh tokens), token management, and device
 * control. All HTTP calls have timeouts and bounded retries on transient errors.
 */
import { logger } from './logger.js';
import type { SmartRentDevice, SmartRentDevicesResponse } from './types.js';

const BASE_URL = 'https://control.smartrent.com';
const USER_AGENT = 'HomeOps/1.0.0';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

interface SmartRentClientConfig {
  email: string;
  password: string;
  unitId: string;
}

interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

interface SessionResponse {
  access_token: string;
  refresh_token?: string;
  expires?: number; // unix epoch seconds
  tfa_api_token?: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Bounded exponential backoff with jitter. Returns ms to wait before retry N.
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

export class SmartRentClient {
  private config: SmartRentClientConfig;
  private tokenInfo: TokenInfo | null = null;
  // Single-flight promise so concurrent callers don't all re-auth at once.
  private inflightAuth: Promise<string> | null = null;
  private cachedHubId: number | null = null;

  constructor(config: SmartRentClientConfig) {
    this.config = config;
  }

  async getAccessToken(): Promise<string> {
    if (this.tokenInfo) {
      const sixtySecondsFromNow = new Date(Date.now() + 60 * 1000);
      if (this.tokenInfo.expiresAt > sixtySecondsFromNow) {
        return this.tokenInfo.accessToken;
      }
      logger.info('Token expiring soon, refreshing');
    }

    if (this.inflightAuth) return this.inflightAuth;
    this.inflightAuth = this.acquireToken().finally(() => {
      this.inflightAuth = null;
    });
    return this.inflightAuth;
  }

  private async acquireToken(): Promise<string> {
    // Try refresh first if we have one; otherwise log in.
    if (this.tokenInfo?.refreshToken) {
      try {
        return await this.refresh(this.tokenInfo.refreshToken);
      } catch (err) {
        logger.warn({ err }, 'Refresh token failed, falling back to login');
        this.tokenInfo = null;
      }
    }
    return this.login();
  }

  private async refresh(refreshToken: string): Promise<string> {
    const response = await fetchWithTimeout(`${BASE_URL}/api/v2/tokens`, {
      method: 'POST',
      headers: {
        'authorization-x-refresh': refreshToken,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`SmartRent refresh failed: ${response.status}`);
    }
    const data = (await response.json()) as SessionResponse;
    this.storeToken(data);
    logger.info({ expiresAt: this.tokenInfo!.expiresAt.toISOString() }, 'Token refreshed');
    return data.access_token;
  }

  async login(): Promise<string> {
    logger.info('Logging in to SmartRent');
    const response = await fetchWithTimeout(`${BASE_URL}/authentication/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error({ status: response.status, body: text }, 'SmartRent login failed');
      throw new Error(`SmartRent login failed: ${response.status}`);
    }

    const data = (await response.json()) as SessionResponse;
    if (data.tfa_api_token) {
      throw new Error('SmartRent 2FA is enabled — disable it for automated use');
    }
    this.storeToken(data);
    logger.info({ expiresAt: this.tokenInfo!.expiresAt.toISOString() }, 'SmartRent login ok');
    return data.access_token;
  }

  private storeToken(data: SessionResponse): void {
    // Prefer the server-provided expiry; fall back to a conservative 14 minutes.
    const expiresAt = data.expires
      ? new Date(data.expires * 1000)
      : new Date(Date.now() + 14 * 60 * 1000);
    this.tokenInfo = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  }

  setToken(accessToken: string, expiresAt: Date, refreshToken?: string): void {
    this.tokenInfo = { accessToken, expiresAt, refreshToken };
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retryOnAuth: boolean = true,
  ): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const token = await this.getAccessToken();
        const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        // Auth expired mid-flight: drop token, retry once with fresh creds.
        if (response.status === 401 && retryOnAuth) {
          logger.warn({ path }, 'Received 401, re-authenticating');
          this.tokenInfo = null;
          return this.request<T>(method, path, body, false);
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          const wait = backoffMs(attempt);
          logger.warn(
            { status: response.status, path, attempt: attempt + 1, waitMs: wait },
            'Retrying after transient SmartRent error',
          );
          await sleep(wait);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          logger.error({ status: response.status, path, body: text }, 'SmartRent API error');
          throw new Error(`SmartRent API error: ${response.status} - ${text}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        // AbortSignal.timeout throws DOMException (TimeoutError); fetch throws
        // TypeError on network failure. Both are retryable.
        const isAbort =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const isNetwork = err instanceof TypeError;

        if ((isAbort || isNetwork) && attempt < MAX_RETRIES) {
          const wait = backoffMs(attempt);
          logger.warn(
            { err, path, attempt: attempt + 1, waitMs: wait },
            'Retrying after network/timeout error',
          );
          lastErr = err;
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }

    throw lastErr ?? new Error('SmartRent request failed after retries');
  }

  private async getHubId(): Promise<number> {
    if (this.cachedHubId !== null) return this.cachedHubId;
    const hubs = await this.request<Array<{ id: number; unit_id: number }>>('GET', '/api/v2/hubs');
    const match = hubs.find((h) => String(h.unit_id) === this.config.unitId);
    if (!match) throw new Error(`No hub found for unit ${this.config.unitId}`);
    this.cachedHubId = match.id;
    return match.id;
  }

  /**
   * Returns the live device list. Uses /api/v2/hubs/:hub_id/devices because:
   *   - /api/v3/units/:id/devices returns days-stale state with a pending_state field
   *   - /api/v2/devices/:id returns one device per call (would require N round trips)
   * The hub endpoint returns fresh device state for the whole unit in one call.
   */
  async getDevices(): Promise<SmartRentDevice[]> {
    const hubId = await this.getHubId();
    const response = await this.request<SmartRentDevice[] | SmartRentDevicesResponse>(
      'GET',
      `/api/v2/hubs/${hubId}/devices`,
    );
    return Array.isArray(response) ? response : response.records;
  }

  async getDevice(deviceId: string): Promise<SmartRentDevice> {
    return this.request<SmartRentDevice>('GET', `/api/v2/devices/${deviceId}`);
  }

  async updateDevice(
    deviceId: string,
    attributes: Array<{ name: string; state: string }>,
  ): Promise<SmartRentDevice> {
    logger.info({ deviceId, attributes }, 'Updating device');
    return this.request<SmartRentDevice>('PATCH', `/api/v2/devices/${deviceId}`, { attributes });
  }

  async lock(deviceId: string): Promise<SmartRentDevice> {
    logger.info({ deviceId }, 'Locking door');
    return this.updateDevice(deviceId, [{ name: 'locked', state: 'true' }]);
  }

  async unlock(deviceId: string): Promise<SmartRentDevice> {
    logger.info({ deviceId }, 'Unlocking door');
    return this.updateDevice(deviceId, [{ name: 'locked', state: 'false' }]);
  }

  async setHeatingSetpoint(deviceId: string, tempF: number): Promise<SmartRentDevice> {
    logger.info({ deviceId, tempF }, 'Setting heating setpoint');
    return this.updateDevice(deviceId, [{ name: 'heating_setpoint', state: String(tempF) }]);
  }

  async setCoolingSetpoint(deviceId: string, tempF: number): Promise<SmartRentDevice> {
    logger.info({ deviceId, tempF }, 'Setting cooling setpoint');
    return this.updateDevice(deviceId, [{ name: 'cooling_setpoint', state: String(tempF) }]);
  }

  async setThermostatMode(
    deviceId: string,
    mode: 'heat' | 'cool' | 'auto' | 'off' | 'aux_heat',
  ): Promise<SmartRentDevice> {
    logger.info({ deviceId, mode }, 'Setting thermostat mode');
    return this.updateDevice(deviceId, [{ name: 'mode', state: mode }]);
  }

  async setFanMode(deviceId: string, fanMode: 'on' | 'auto'): Promise<SmartRentDevice> {
    logger.info({ deviceId, fanMode }, 'Setting fan mode');
    return this.updateDevice(deviceId, [{ name: 'fan_mode', state: fanMode }]);
  }

  async setThermostatTarget(
    deviceId: string,
    tempF: number,
    mode: 'heat' | 'cool' | 'auto',
  ): Promise<SmartRentDevice> {
    const attributes: Array<{ name: string; state: string }> = [];
    if (mode === 'heat' || mode === 'auto') {
      attributes.push({ name: 'heating_setpoint', state: String(tempF) });
    }
    if (mode === 'cool' || mode === 'auto') {
      attributes.push({ name: 'cooling_setpoint', state: String(tempF) });
    }
    attributes.push({ name: 'mode', state: mode });
    logger.info({ deviceId, tempF, mode, attributes }, 'Setting thermostat target');
    return this.updateDevice(deviceId, attributes);
  }
}

export function parseLockState(device: SmartRentDevice): 'locked' | 'unlocked' | 'unknown' {
  const lockedAttr = device.attributes.find((a) => a.name === 'locked');
  if (!lockedAttr) return 'unknown';
  if (lockedAttr.state === 'true') return 'locked';
  if (lockedAttr.state === 'false') return 'unlocked';
  return 'unknown';
}

function normalizeMode(raw: string | undefined): 'heat' | 'cool' | 'auto' | 'off' | 'unknown' {
  const m = raw === 'aux_heat' ? 'heat' : raw;
  if (m === 'heat' || m === 'cool' || m === 'auto' || m === 'off') return m;
  return 'unknown';
}

export function parseThermostatState(device: SmartRentDevice): {
  mode: 'heat' | 'cool' | 'auto' | 'off' | 'unknown';
  currentTempF?: number;
  targetTempF?: number;
  humidityPct?: number;
  fanMode?: 'on' | 'auto';
  operatingState?: string;
  pendingMode?: 'heat' | 'cool' | 'auto' | 'off' | 'unknown';
  pendingTargetTempF?: number;
} {
  const attr = (name: string) => device.attributes.find((a) => a.name === name);
  const getState = (name: string): string | undefined => attr(name)?.state;
  const getPending = (name: string): string | undefined => attr(name)?.pending_state ?? undefined;

  const mode = normalizeMode(getState('mode'));
  const pendingModeRaw = getPending('mode');
  const pendingMode = pendingModeRaw ? normalizeMode(pendingModeRaw) : undefined;

  const heatingSetpoint = getState('heating_setpoint');
  const coolingSetpoint = getState('cooling_setpoint');
  const heatingPending = getPending('heating_setpoint');
  const coolingPending = getPending('cooling_setpoint');

  // Confirmed target: setpoint that matches current mode.
  let targetTempF: number | undefined;
  if (mode === 'heat' && heatingSetpoint) targetTempF = parseInt(heatingSetpoint, 10);
  else if (mode === 'cool' && coolingSetpoint) targetTempF = parseInt(coolingSetpoint, 10);
  else if (heatingSetpoint) targetTempF = parseInt(heatingSetpoint, 10);

  // Pending target: pick the pending value that matches whatever mode is in flight.
  const effectivePendingMode = pendingMode ?? mode;
  let pendingTargetTempF: number | undefined;
  if (effectivePendingMode === 'heat' && heatingPending) {
    pendingTargetTempF = parseInt(heatingPending, 10);
  } else if (effectivePendingMode === 'cool' && coolingPending) {
    pendingTargetTempF = parseInt(coolingPending, 10);
  } else if (heatingPending) {
    pendingTargetTempF = parseInt(heatingPending, 10);
  } else if (coolingPending) {
    pendingTargetTempF = parseInt(coolingPending, 10);
  }

  const currentTemp = getState('current_temp');
  const humidity = getState('current_humidity');
  const fan = getState('fan_mode');

  return {
    mode,
    currentTempF: currentTemp ? parseInt(currentTemp, 10) : undefined,
    targetTempF,
    humidityPct: humidity ? parseInt(humidity, 10) : undefined,
    fanMode: fan === 'on' || fan === 'auto' ? fan : undefined,
    operatingState: getState('operating_state'),
    pendingMode,
    pendingTargetTempF,
  };
}
