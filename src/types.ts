/**
 * HomeOps Type Definitions
 * Canonical device state models and API types
 */

export type LockState = 'locked' | 'unlocked' | 'unknown';
export type ThermostatMode = 'heat' | 'cool' | 'auto' | 'off' | 'unknown';
export type DeviceId = 'L1' | 'B1' | 'B2' | 'B3';

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
