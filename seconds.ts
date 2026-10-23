/** Seconds machinery: parse/validate/resolution for poll interval, cache TTL, and poll timeout. */

import {
  DEFAULT_AUTH_BACKOFF_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_AUTH_BACKOFF_SECONDS,
  MIN_CACHE_FOR_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  MIN_POLL_TIMEOUT_SECONDS,
  POLL_TIMEOUT_MS,
  authBackoffWarns,
  cacheForWarns,
  intervalWarns,
  pollTimeoutWarns,
  type AutoTargetMessage,
  type WarnState,
} from "./core.ts";

/** A valid interval: a finite number of seconds at or above the floor. */
export function parseIntervalSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_POLL_INTERVAL_SECONDS
    ? value
    : undefined;
}

/**
 * A valid cache TTL: a finite number of seconds above zero. Values below the
 * floor are clamped up to it; non-numeric values are invalid.
 */
export function parseCacheForSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < MIN_CACHE_FOR_SECONDS ? MIN_CACHE_FOR_SECONDS : value;
}

/**
 * A valid poll timeout: a finite whole number of seconds above zero. Values
 * below the floor are clamped up to it; non-numeric or fractional values are
 * invalid.
 */
export function parsePollTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value < MIN_POLL_TIMEOUT_SECONDS ? MIN_POLL_TIMEOUT_SECONDS : value;
}

/** Outcome of validating one raw seconds value against a spec. */
type SecondsValueOutcome = {
  value: number | undefined;
  /** undefined = no warning; "invalid" or "clamped" describe the warning. */
  kind: "invalid" | "clamped" | undefined;
};
function parseSecondsValue(raw: unknown, spec: SecondsOptionSpec): SecondsValueOutcome {
  const value = spec.parse(raw);
  if (value === undefined) return { value: undefined, kind: raw === undefined ? undefined : "invalid" };
  return { value, kind: raw !== value ? "clamped" : undefined };
}

/** Per-feature knobs for the poll-interval and cache-TTL machinery. */
interface SecondsOptionSpec {
  /** Parse/validate one raw value; may clamp below-min values. undefined = invalid. */
  parse(value: unknown): number | undefined;
  /** Field name used in warning text ("intervalSeconds" or "cacheFor"). */
  field: string;
  /** Text after "is invalid", e.g. "(min 15); using default 300s.". */
  invalidSuffix: string;
  /** Floor in seconds, used in clamp warning text. */
  min: number;
  /** Warn-once key for the env source ("env:" vs "env"). */
  envKey: string;
  /** Env var name used in env warning text. */
  envSource: string;
  /** Value returned when every source is unset or invalid. */
  fallback: number | undefined;
}

/** Describe one invalid value without exposing key material. */
function invalidSecondsMessage(spec: SecondsOptionSpec, source: string, value: unknown): string {
  return `${source} ${spec.field}=${String(value)} is invalid ${spec.invalidSuffix}`;
}

/** Describe a below-min value that was clamped up to the floor. */
function clampedSecondsMessage(spec: SecondsOptionSpec, source: string, value: unknown): string {
  return `${source} ${spec.field}=${String(value)} below min ${spec.min}s; using ${spec.min}s.`;
}

/** Poll-interval knobs: below-min values are invalid, not clamped. */
export const INTERVAL_SPEC = {
  parse: parseIntervalSeconds,
  field: "intervalSeconds",
  invalidSuffix: `(min ${MIN_POLL_INTERVAL_SECONDS}); using default ${DEFAULT_POLL_INTERVAL_SECONDS}s.`,
  min: MIN_POLL_INTERVAL_SECONDS,
  envKey: "env:",
  envSource: "OPENCODE_MODELS_DISCOVERY_INTERVAL_SECONDS",
  fallback: DEFAULT_POLL_INTERVAL_SECONDS,
} satisfies SecondsOptionSpec;

/** Cache-TTL knobs: below-min values clamp up to the floor. */
export const CACHE_FOR_SPEC = {
  parse: parseCacheForSeconds,
  field: "cacheFor",
  invalidSuffix: "(non-numeric); ignoring.",
  min: MIN_CACHE_FOR_SECONDS,
  envKey: "env",
  envSource: "OPENCODE_MODELS_DISCOVERY_CACHE_FOR_SECONDS",
  fallback: undefined,
} satisfies SecondsOptionSpec;

/** Poll-timeout knobs: below-min values clamp up to the floor. */
export const POLL_TIMEOUT_SPEC = {
  parse: parsePollTimeoutSeconds,
  field: "pollTimeoutSeconds",
  invalidSuffix: `(min ${MIN_POLL_TIMEOUT_SECONDS}); using default ${POLL_TIMEOUT_MS / 1000}s.`,
  min: MIN_POLL_TIMEOUT_SECONDS,
  envKey: "env:",
  envSource: "OPENCODE_MODELS_DISCOVERY_POLL_TIMEOUT_SECONDS",
  fallback: POLL_TIMEOUT_MS / 1000,
} satisfies SecondsOptionSpec;

/**
 * Auth-failure pause knobs: `0` disables the pause; other below-min values
 * clamp up to the floor. Non-numeric values fall through to the default.
 */
export function parseAuthBackoffSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return 0;
  const whole = Math.trunc(value);
  return whole < MIN_AUTH_BACKOFF_SECONDS ? MIN_AUTH_BACKOFF_SECONDS : whole;
}

export const AUTH_BACKOFF_SPEC = {
  parse: parseAuthBackoffSeconds,
  field: "authBackoffSeconds",
  invalidSuffix: `(non-numeric); using default ${DEFAULT_AUTH_BACKOFF_SECONDS}s.`,
  min: MIN_AUTH_BACKOFF_SECONDS,
  envKey: "env:auth-backoff",
  envSource: "OPENCODE_MODELS_DISCOVERY_AUTH_BACKOFF_SECONDS",
  fallback: DEFAULT_AUTH_BACKOFF_SECONDS,
} satisfies SecondsOptionSpec;

/**
 * Resolve one seconds option with per-provider > options > env > fallback
 * precedence. Invalid values fall through to the next source and warn once
 * per source key; a parsed value differing from the raw one was clamped and
 * warns too. The env source accepts its raw string form.
 */
function resolveSecondsOption(
  perProvider: unknown,
  options: unknown,
  envValue: unknown,
  spec: SecondsOptionSpec,
  warns: WarnState,
): number | undefined {
  const resolveSource = (raw: unknown, key: string, label: string): number | undefined => {
    const outcome = parseSecondsValue(raw, spec);
    if (outcome.kind === "invalid") {
      warns.warn(key, invalidSecondsMessage(spec, label, raw));
    } else if (outcome.kind === "clamped") {
      warns.warn(key, clampedSecondsMessage(spec, label, raw));
    }
    return outcome.value;
  };
  const fromProvider = resolveSource(perProvider, "provider", "modelsDiscovery");
  if (fromProvider !== undefined) return fromProvider;
  const fromOptions = resolveSource(options, "options", "options");
  if (fromOptions !== undefined) return fromOptions;
  const envRaw =
    typeof envValue === "string" && envValue.trim().length > 0 ? Number(envValue) : envValue;
  const envOutcome = parseSecondsValue(envRaw, spec);
  if (envOutcome.value !== undefined) {
    if (envOutcome.kind === "clamped") {
      warns.warn(spec.envKey, clampedSecondsMessage(spec, spec.envSource, envRaw));
    }
    return envOutcome.value;
  }
  if (envValue !== undefined) {
    warns.warn(spec.envKey, invalidSecondsMessage(spec, spec.envSource, envValue));
  }
  return spec.fallback;
}

/**
 * Resolve the poll interval (seconds) with per-provider > options > env >
 * default precedence. Invalid values fall through to the next source and warn
 * once per source key; the env source accepts its raw string form.
 */
export function resolveIntervalSeconds(
  perProvider?: unknown,
  options?: unknown,
  envValue?: unknown,
): number {
  // Narrow the number|undefined result; INTERVAL_SPEC.fallback is the default.
  return (
    resolveSecondsOption(perProvider, options, envValue, INTERVAL_SPEC, intervalWarns) ??
    DEFAULT_POLL_INTERVAL_SECONDS
  );
}

/**
 * Resolve the success TTL (seconds) with per-provider > options > env
 * precedence; unset means the feature is off. Non-numeric values fall
 * through to the next source and warn once per source key; below-min values
 * clamp to the floor. The env source accepts its raw string form.
 */
export function resolveCacheForSeconds(
  perProvider?: unknown,
  options?: unknown,
  envValue?: unknown,
): number | undefined {
  return resolveSecondsOption(perProvider, options, envValue, CACHE_FOR_SPEC, cacheForWarns);
}

/**
 * Resolve the poll timeout (seconds) with per-provider > options > env >
 * default precedence. Invalid values fall through to the next source and warn
 * once per source key; below-min values clamp to the floor with a warning.
 * The env source accepts its raw string form.
 */
export function resolvePollTimeoutSeconds(
  perProvider?: unknown,
  options?: unknown,
  envValue?: unknown,
): number {
  // Narrow the number|undefined result; POLL_TIMEOUT_SPEC.fallback is the default.
  return (
    resolveSecondsOption(perProvider, options, envValue, POLL_TIMEOUT_SPEC, pollTimeoutWarns) ??
    POLL_TIMEOUT_MS / 1000
  );
}

/**
 * Resolve the auth-failure pause (seconds) with options > env > default
 * precedence. `0` disables the pause. Invalid values fall through to the next
 * source and warn once per source key.
 */
export function resolveAuthBackoffSeconds(
  options?: unknown,
  envValue?: unknown,
): number {
  return (
    resolveSecondsOption(undefined, options, envValue, AUTH_BACKOFF_SPEC, authBackoffWarns) ??
    DEFAULT_AUTH_BACKOFF_SECONDS
  );
}

/** Parse a per-provider seconds value at selection time; warns once per provider id. */
export function parseProviderSecondsOption(
  raw: unknown,
  spec: SecondsOptionSpec,
  id: string,
  warns: WarnState,
  messages: AutoTargetMessage[],
): number | undefined {
  const outcome = parseSecondsValue(raw, spec);
  if (outcome.kind) {
    const prefix = `Provider "${id}": modelsDiscovery.${spec.field}`;
    warns.warn(
      `provider:"${id}"`,
      outcome.kind === "invalid"
        ? `${prefix}=${String(raw)} is invalid ${spec.invalidSuffix}`
        : `${prefix}=${String(raw)} below min ${spec.min}s; using ${spec.min}s.`,
      messages,
    );
  }
  return outcome.value;
}
