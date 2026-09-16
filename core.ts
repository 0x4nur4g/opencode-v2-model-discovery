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

/** Warn-once states for the interval, cache TTL, poll timeout, auth env, and watch paths. */
export const intervalWarns = createWarnState();
export const cacheForWarns = createWarnState();
export const pollTimeoutWarns = createWarnState();
export const authEnvWarns = createWarnState();
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

export interface AutoTargetMessage {
  readonly level: "log" | "warn";
  readonly message: string;
}
