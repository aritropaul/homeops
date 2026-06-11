/**
 * HomeOps Type Definitions
 * Canonical device state models and API types
 */

export type LockState = 'locked' | 'unlocked' | 'unknown';
export type ThermostatMode = 'heat' | 'cool' | 'auto' | 'off' | 'unknown';
export type DeviceId = 'L1' | 'B1' | 'B2' | 'B3';

/** Who's home / what the comfort engine should be optimizing for. */
export type Occupancy = 'home' | 'away' | 'arriving' | 'sleep';

export interface DeviceState {
  ts: string;
}

export interface LockDeviceState extends DeviceState {
  deviceId: 'L1';
  lockState: LockState;
  batteryPct?: number;
  online: boolean;
  /** Most recent SmartRent notification (e.g. UNLOCK_VIA_RF, KEY_OR_THUMBTURN_UNLOCK). */
  lastNotification?: string;
  lastNotificationTs?: string;
}

export interface ThermostatDeviceState extends DeviceState {
  deviceId: 'B1' | 'B2' | 'B3';
  mode: ThermostatMode;
  currentTempF?: number;
  targetTempF?: number;
  humidityPct?: number;
  online: boolean;
  /** Mode we asked SmartRent to set but the device hasn't confirmed yet. */
  pendingMode?: ThermostatMode;
  /** Setpoint we asked SmartRent to set but the device hasn't confirmed yet. */
  pendingTargetTempF?: number;
}

export interface LockTracking {
  unlockedSince?: string;
  lastAutoLockAttempt?: string;
}

export interface Throttles {
  lastUnlockAt?: string;
  lastLockAt?: string;
  lastPreheatAt?: string;
  /** Last time the comfort engine issued a command to B2 (anti-short-cycle). */
  lastComfortAt?: string;
}

/** Current comfort intent for the B2 engine. */
export interface OccupancyState {
  intent: Occupancy;
  since: string;
  /** For 'arriving': absolute time we expect to be home. */
  etaTs?: string;
}

/**
 * A manual setpoint the user pinned via /thermostat. While active, the comfort
 * engine leaves B2 alone so it doesn't fight the human.
 */
export interface ManualOverride {
  setpointF: number;
  mode: 'heat' | 'cool' | 'auto' | 'off';
  untilTs: string;
}

/** The engine's most recent decision — surfaced on /status for visibility. */
export interface ComfortDecision {
  mode: 'heat' | 'cool' | 'off';
  setpointF?: number;
  reason: string;
  ts: string;
}

/** Outdoor conditions from the weather provider. */
export interface OutdoorWeather {
  tempF: number;
  humidityPct: number;
  forecastHighF: number;
  forecastLowF: number;
  ts: string;
}

/** One row of B2 thermal history, used to learn heating/cooling rates. */
export interface ThermalSample {
  ts: string;
  indoorF?: number;
  outdoorF?: number;
  mode: ThermostatMode;
  setpointF?: number;
}

export interface HomeOpsState {
  devices: {
    L1: LockDeviceState;
    B1: ThermostatDeviceState;
    B2: ThermostatDeviceState;
    B3: ThermostatDeviceState;
  };
  lockTracking: LockTracking;
  throttles: Throttles;
  /** Comfort engine intent (defaults to 'home' when unset). */
  occupancy?: OccupancyState;
  /** Active manual override on B2, if any. */
  manualOverride?: ManualOverride;
  /** Last decision the engine made (for /status). */
  lastComfortDecision?: ComfortDecision;
  lastPollTs?: string;
  lastErrorTs?: string;
  lastError?: string;
}

export interface SmartRentAttribute {
  name: string;
  state: string;
  pending_state: string | null;
  last_read_at: string | null;
  pending_state_requested_at: string | null;
}

export interface SmartRentDevice {
  id: number;
  name: string;
  type: string;
  attributes: SmartRentAttribute[];
  battery_level: number;
  battery_powered: boolean;
  online: boolean;
  model: string;
  primary_lock: boolean;
}

export interface SmartRentDevicesResponse {
  records: SmartRentDevice[];
  current_page: number;
  total_pages: number;
  total_records: number;
}

export interface SmartRentAuthResponse {
  access_token: string;
  tfa_api_token: string | null;
  redirect_to_on_login: string | null;
}

export interface HomeOpsResponse {
  ok: boolean;
  response: string;
}

export interface HealthResponse {
  ok: boolean;
  lastPollTs?: string;
  lastErrorTs?: string;
  lastError?: string;
  degraded: boolean;
}

export interface StatusResponse {
  devices: HomeOpsState['devices'];
  lockTracking: LockTracking;
  throttles: Throttles;
  lastPollTs?: string;
  lastErrorTs?: string;
}
