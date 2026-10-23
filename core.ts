/** Shared leaf: constants, warn-once dedupe state, and tiny guards. No node imports. */

/** Default poll cadence (seconds) when no source configures one. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
/** Hard floor for any configured interval; smaller values are rejected. */
export const MIN_POLL_INTERVAL_SECONDS = 15;
/** Hard floor for a configured cache TTL; smaller values are clamped up. */
export const MIN_CACHE_FOR_SECONDS = 60;
/** Scheduler tick granularity: due-ness is re-evaluated once per second. */
export const TICK_MS = 1000;
/**
 * Default per-poll fetch timeout (ms). 20s because slow providers (e.g.
 * bifrost 708-model catalogs) exceed 5-8s; the old 8s default aborted them
 * and surfaced 0 models.
 */
export const POLL_TIMEOUT_MS = 20_000;
/** Hard floor for a configured poll timeout (seconds); smaller values clamp up. */
export const MIN_POLL_TIMEOUT_SECONDS = 5;
/**
 * Absolute ceiling on one poll (headers + every body byte), as a multiple of
 * the stall timeout. The stall timeout aborts only when no bytes arrive for
 * its whole window, so a slow-drip body could otherwise hold the serialized
 * refresh queue open indefinitely; this ceiling still ends it.
 */
export const POLL_TOTAL_TIMEOUT_MULTIPLIER = 10;
/** Default auth-failure pause (seconds) after a 401/403 from a provider. */
export const DEFAULT_AUTH_BACKOFF_SECONDS = 1_800;
/** Hard floor for a configured auth-failure pause (seconds); 0 disables it. */
export const MIN_AUTH_BACKOFF_SECONDS = 60;
/** Default page cap for a provider that opts into pagination. */
export const DEFAULT_PAGINATION_MAX_PAGES = 10;
/** Hard ceiling for a configured page cap, regardless of config. */
export const MAX_PAGINATION_PAGES = 100;
export const LOG_PREFIX = "[opencode-v2-model-discovery]";

/** Warn-once dedupe per source key; messages ride a selection log when given. */
export interface WarnState {
  warn(key: string, message: string, messages?: AutoTargetMessage[]): void;
  reset(): void;
}

/** Internal factory shared by the warn-once states below. */
export function createWarnState(): WarnState {
  const warned = new Set<string>();
  return {
    warn(key, message, messages) {
      if (warned.has(key)) return;
      warned.add(key);
      if (messages) messages.push({ level: "warn", message });
      else console.warn(`${LOG_PREFIX} ${message}`);
    },
    reset() {
      warned.clear();
    },
  };
}

/** Warn-once states for the interval, cache TTL, poll timeout, auth, and watch paths. */
export const intervalWarns = createWarnState();
export const cacheForWarns = createWarnState();
export const pollTimeoutWarns = createWarnState();
export const authEnvWarns = createWarnState();
export const authBackoffWarns = createWarnState();
export const watchWarns = createWarnState();

/** Test-only reset of the once-per-process poll timeout warning dedupe. */
export function resetWarnedPollTimeoutKeys(): void {
  pollTimeoutWarns.reset();
}

/** Test-only reset of the once-per-process auth env warning dedupe. */
export function resetWarnedAuthEnvIds(): void {
  authEnvWarns.reset();
}

/** Test-only reset of the once-per-process interval warning dedupe. */
export function resetWarnedIntervalKeys(): void {
  intervalWarns.reset();
}

/** Test-only reset of the once-per-process cache TTL warning dedupe. */
export function resetWarnedCacheForKeys(): void {
  cacheForWarns.reset();
}

/** Test-only reset of the once-per-process auth backoff warning dedupe. */
export function resetWarnedAuthBackoffKeys(): void {
  authBackoffWarns.reset();
}

/** Test-only reset of the once-per-path watch warning dedupe. */
export function resetWarnedWatchPaths(): void {
  watchWarns.reset();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeFailure(operation: string, marker: string, status?: number): void {
  console.warn(
    `${LOG_PREFIX} ${operation} failed: marker=${marker}; status=${status ?? "unknown"}`,
  );
}

/**
 * Error constructor name for diagnostics (TypeError, SchemaError, ...).
 * Name only — message/stack are never logged, so raw error text (which could
 * carry URLs, keys, or response bodies) can never reach the logs. Keeps the
 * sanitized-logs rule intact while still distinguishing "host surface moved"
 * (TypeError) from "host rejected our payload" (SchemaError-class).
 */
export function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name.length <= 64) return name;
  }
  return "unknown";
}

export function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.trim().toLowerCase() === "true";
}

/**
 * Boot-mode precedence: plugin option `background` > env
 * OPENCODE_MODELS_DISCOVERY_BACKGROUND > default background (true).
 *
 * Background boot (the default) keeps the first provider poll off the host's
 * plugin-activation path: setup resolves immediately and the scheduler tick
 * starts the first cycle afterwards. Blocking boot (false) awaits that first
 * cycle inside setup for callers that need discovered models present before
 * setup resolves. The env is tri-state like the other discovery envs: "true"/
 * "1" and "false"/"0" are explicit, anything else falls through to the default.
 */
export function resolveBackgroundBoot(
  optionValue: unknown,
  envValue: string | undefined,
): boolean {
  if (typeof optionValue === "boolean") return optionValue;
  const value = envValue?.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return true;
}

/** Default deferral for the first catalog application in background boot. */
export const DEFAULT_BACKGROUND_DEFER_MS = 3000;

/**
 * Background-boot application deferral: plugin option `backgroundDeferMs` >
 * env OPENCODE_MODELS_DISCOVERY_BACKGROUND_DEFER_MS > default 3000ms.
 * Clamped to 0..60000. The deferral keeps the plugin's catalog application
 * (one expensive per-model draft pass per host rebuild) off the host's
 * boot-time rebuilds.
 */
export function resolveBackgroundDeferMs(
  optionValue: unknown,
  envValue: string | undefined,
): number {
  const envRaw = envValue?.trim();
  const raw =
    typeof optionValue === "number" && Number.isFinite(optionValue)
      ? optionValue
      : envRaw !== undefined && envRaw !== ""
        ? Number(envRaw)
        : Number.NaN;
  if (!Number.isFinite(raw)) return DEFAULT_BACKGROUND_DEFER_MS;
  return Math.min(60_000, Math.max(0, Math.trunc(raw)));
}

export interface AutoTargetMessage {
  readonly level: "log" | "warn";
  readonly message: string;
}
