/**
 * Steward Sidecar types and constants.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StewardSidecarConfig {
  /** Directory for Steward data (PGLite storage, config, secrets). */
  dataDir: string;
  /** Port for the local Steward API. Default: 3200 */
  port?: number;
  /** Master password for Steward's vault encryption. Auto-generated on first launch if not set. */
  masterPassword?: string;
  /** Path to the steward API entry point (bun script). */
  stewardEntryPoint?: string;
  /** DATABASE_URL override. When empty, sidecar will look for PGLite or use dataDir-based config. */
  databaseUrl?: string;
  /** Max restart attempts before giving up. Default: 5 */
  maxRestarts?: number;
  /** Callback for status changes (for UI indicators). */
  onStatusChange?: (status: StewardSidecarStatus) => void;
  /** Callback for log output from the child process. */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface StewardSidecarStatus {
  state: "stopped" | "starting" | "running" | "error" | "restarting";
  port: number | null;
  pid: number | null;
  error: string | null;
  restartCount: number;
  walletAddress: string | null;
  agentId: string | null;
  tenantId: string | null;
  startedAt: number | null;
}

export interface StewardWalletInfo {
  tenantId: string;
  tenantApiKey: string;
  agentId: string;
  agentName: string;
  agentToken: string;
  walletAddress: string;
}

/** Durable local setup state; the token is absent while acquisition awaits retry. */
export interface StewardCredentialCheckpoint {
  tenantId: string;
  tenantApiKey: string;
  agentId: string;
  agentToken?: string;
  walletAddress: string;
  masterPassword?: string;
}

/** Complete credentials exposed after wallet setup succeeds. */
export interface StewardCredentials extends StewardCredentialCheckpoint {
  agentToken: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3200;
export const DEFAULT_MAX_RESTARTS = 5;
/** Highest crash-restart count a sidecar config can request. */
export const STEWARD_RESTART_HARD_MAX = 10;

/**
 * Crash restarts stay finite. An omitted value keeps the default of 5.
 * Zero keeps the no-restart setting. Invalid numbers fail closed at zero
 * so a bad value cannot restart without a stop. Values above the hard
 * ceiling are clamped.
 */
export function resolveStewardMaxRestarts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESTARTS;
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, STEWARD_RESTART_HARD_MAX);
}
export const HEALTH_CHECK_INTERVAL_MS = 500;
export const HEALTH_CHECK_TIMEOUT_MS = 30_000;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const DEFAULT_TENANT_ID = "elizaos-desktop";
export const DEFAULT_TENANT_NAME = "Desktop";
export const DEFAULT_AGENT_ID = "eliza-wallet";
export const DEFAULT_AGENT_NAME = "eliza-wallet";
export const CREDENTIALS_FILE = "credentials.json";
