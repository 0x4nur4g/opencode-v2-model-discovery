/**
 * Experiential Labs catalog enrichment: keyless route-effort lookup.
 *
 * The gateway's `/v1/models` listing is bare (ids only), while the public
 * catalog at https://api.experientiallabs.ai/api/models carries per-route
 * reasoning efforts. Only the model's DEFAULT route — the providers[] row
 * whose id equals default_provider_ids[0] — is ever read: never a second
 * default, never a non-default route, never another provider's definition.
 * Keyless by design: the catalog request carries no Authorization, Cookie, or
 * provider headers.
 *
 * The catalog page is large (~4.25 MB measured), so the lookup runs on its own
 * schedule, not the models poll cadence: successes are reused for 24 h by
 * default (900 s floor), failures back off for 1 h, and concurrent callers
 * share one in-flight request per URL. Only the force-mode rescan command
 * bypasses the TTL.
 */

import { createWarnState, isRecord, safeFailure } from "./core.ts";

/** Host that owns the public catalog; host equality is exact (no suffix match). */
export const EXPERIENTIAL_CATALOG_HOST = "api.experientiallabs.ai";

/** Acceptance seam: same-host[:port] redirect for the catalog fetch. */
export const EXPERIENTIAL_CATALOG_URL_ENV = "OPENCODE_MODELS_DISCOVERY_EXPERIENTIAL_CATALOG_URL";

const EXPERIENTIAL_CATALOG_URL = `https://${EXPERIENTIAL_CATALOG_HOST}/api/models`;

/** Vendor page size and the hard page cap for the catalog listing. */
const CATALOG_PAGE_LIMIT = 1000;
const CATALOG_MAX_PAGES = 10;

/** Total attempts per request: the initial attempt plus one bounded retry. */
const CATALOG_MAX_ATTEMPTS = 2;

/** Default success TTL for the catalog lookup, and its floor, in seconds. */
export const EXPERIENTIAL_CATALOG_TTL_SECONDS = 86_400;
export const MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS = 900;
/** Env override for the catalog success TTL (seconds). */
export const EXPERIENTIAL_CATALOG_TTL_ENV =
  "OPENCODE_MODELS_DISCOVERY_EXPERIENTIAL_CATALOG_TTL_SECONDS";
/** Failure backoff (seconds): a failed catalog fetch stays ineligible this long. */
const CATALOG_FAILURE_BACKOFF_SECONDS = 3_600;

export interface ExperientialRouteEfforts {
  /** Efforts the default route declares; present only for a POSITIVE route. */
  readonly efforts?: string[];
  /**
   * Explicit negative: the default route says no usable efforts exist (or is
   * unusable), so guessed join variants must not be presented for the model.
   */
  readonly denied: boolean;
}

export type ExperientialEffortsMap = ReadonlyMap<string, ExperientialRouteEfforts>;

/** Fetch knobs: TTL/bypass/clock/fetch seams; production callers pass none of them. */
export interface ExperientialCatalogFetchOptions {
  /** Force-mode TTL bypass (models-discovery-rescan command only). */
  readonly bypassTtl?: boolean;
  /** Success TTL override in seconds (floor-clamped); default 86400. */
  readonly ttlSeconds?: number;
  /** Clock injection for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Fetch implementation injection for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

function parseURL(value: string | undefined): URL | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

/**
 * Resolve the catalog URL for a provider baseURL. Undefined means "not an
 * Experiential Labs target". The env seam is honored only when its
 * host[:port] matches the provider's own host[:port]; a misconfigured seam
 * never silently falls back to the public catalog.
 */
export function experientialCatalogURL(
  baseURL: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const provider = parseURL(baseURL);
  if (provider === undefined) return undefined;
  const overrideRaw = env[EXPERIENTIAL_CATALOG_URL_ENV];
  if (typeof overrideRaw === "string" && overrideRaw.trim() !== "") {
    const override = parseURL(overrideRaw);
    return override !== undefined && override.host.toLowerCase() === provider.host.toLowerCase()
      ? overrideRaw.trim()
      : undefined;
  }
  return provider.hostname.toLowerCase() === EXPERIENTIAL_CATALOG_HOST
    ? EXPERIENTIAL_CATALOG_URL
    : undefined;
}

function parseEffortList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const efforts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const effort = entry.trim();
    if (effort.length === 0) return undefined;
    efforts.push(effort);
  }
  return efforts;
}

function parseDefaultRouteID(entry: Record<string, unknown>): string | undefined {
  const defaults = entry.default_provider_ids;
  if (!Array.isArray(defaults) || defaults.length === 0) return undefined;
  const first = defaults[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function findRoute(providers: unknown, routeID: string): Record<string, unknown> | undefined {
  if (!Array.isArray(providers)) return undefined;
  for (const provider of providers) {
    if (isRecord(provider) && provider.id === routeID) return provider;
  }
  return undefined;
}

/** A declared default route that exists and is active/routable. */
function routeIsUsable(route: Record<string, unknown>): boolean {
  return route.status === "active" && route.routable !== false;
}

/**
 * One catalog entry → one map entry. Three outcomes:
 * - POSITIVE: the declared default route (default_provider_ids[0] matched in
 *   providers[] by id) is active and not unroutable, and declares a non-empty
 *   supported_reasoning_efforts string array → authoritative efforts.
 * - EXPLICIT-DENY: the route is unusable, explicitly says
 *   supports_reasoning=false, or its effort list is present but empty.
 * - UNKNOWN: no declared default route, an unmatched route id, or a matched
 *   route that makes no statement about efforts (neither capability key
 *   present, or supports_reasoning=true with the list absent). UNKNOWN
 *   contributes NO map entry, so the model keeps the merge contract's
 *   "fill missing fields" behavior with candidate join values.
 * Other routes in the same entry are never consulted.
 */
function parseRouteEfforts(
  entry: unknown,
): { slug: string; route: ExperientialRouteEfforts } | undefined {
  if (!isRecord(entry) || !isRecord(entry.model)) return undefined;
  const slug = entry.model.slug;
  if (typeof slug !== "string" || slug.length === 0) return undefined;
  const routeID = parseDefaultRouteID(entry);
  if (routeID === undefined) return undefined;
  const route = findRoute(entry.providers, routeID);
  if (route === undefined) return undefined;
  if (!routeIsUsable(route)) return { slug, route: { denied: true } };
  const capabilities = isRecord(route.capabilities) ? route.capabilities : undefined;
  const rawEfforts = capabilities?.supported_reasoning_efforts;
  const efforts = parseEffortList(rawEfforts);
  if (efforts !== undefined) return { slug, route: { denied: false, efforts } };
  const effortsDeclaredEmpty =
    capabilities !== undefined &&
    "supported_reasoning_efforts" in capabilities &&
    Array.isArray(rawEfforts) &&
    rawEfforts.length === 0;
  const reasoningDeclaredOff =
    capabilities !== undefined && capabilities.supports_reasoning === false;
  if (effortsDeclaredEmpty || reasoningDeclaredOff) return { slug, route: { denied: true } };
  return undefined;
}

/** One request attempt chain: keyless GET, bounded retries, JSON body or undefined. */
async function fetchCatalogPage(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown | undefined> {
  for (let attempt = 1; attempt <= CATALOG_MAX_ATTEMPTS; attempt += 1) {
    try {
      // Keyless: no headers of any kind — never Authorization, Cookie, or
      // provider headers.
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) continue;
      try {
        return await response.json();
      } catch {
        continue;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Fetch every page (limit 1000, hard cap 10) into one slug → route map. */
async function loadCatalog(
  catalogURL: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Map<string, ExperientialRouteEfforts> | undefined> {
  const combined = new Map<string, ExperientialRouteEfforts>();
  let offset = 0;
  for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
    const url = new URL(catalogURL);
    url.searchParams.set("limit", String(CATALOG_PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    const body = await fetchCatalogPage(url.toString(), timeoutMs, fetchImpl);
    if (body === undefined) return undefined;
    if (!isRecord(body) || !Array.isArray(body.models)) return undefined;
    for (const entry of body.models) {
      const parsed = parseRouteEfforts(entry);
      if (parsed !== undefined) combined.set(parsed.slug, parsed.route);
    }
    if (body.models.length < CATALOG_PAGE_LIMIT) break;
    offset += body.models.length;
  }
  return combined;
}

/** Last outcome per catalog URL: the last-good map plus success/failure clocks. */
interface CatalogCacheEntry {
  /** Last good map; undefined when no fetch has ever succeeded for this URL. */
  readonly map: ReadonlyMap<string, ExperientialRouteEfforts> | undefined;
  /** Last success time (ms); 0 = never. */
  readonly at: number;
  /** Last failure time (ms); 0 = never. */
  readonly failureAt: number;
}

/** Keep-last-good cache keyed by catalog URL; a failed refresh keeps the previous map. */
const catalogCache = new Map<string, CatalogCacheEntry>();
/** In-flight request per catalog URL: concurrent callers await the same fetch. */
const catalogInflight = new Map<
  string,
  Promise<Map<string, ExperientialRouteEfforts> | undefined>
>();

/** Warn-once dedupe for invalid/clamped catalog TTL configuration. */
const catalogWarns = createWarnState();

/** A valid success TTL: seconds above zero; below-floor values clamp up. */
export function parseExperientialCatalogTtlSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS
    ? MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS
    : value;
}

/**
 * Resolve the catalog success TTL: explicit option > env > 24 h default.
 * Invalid values fall through with a warn-once message; below-floor values
 * clamp up to the floor. The env source accepts its raw string form.
 */
export function resolveExperientialCatalogTtlSeconds(
  optionValue?: unknown,
  envValue?: unknown,
): number {
  const fromOption = parseExperientialCatalogTtlSeconds(optionValue);
  if (fromOption !== undefined) return fromOption;
  if (optionValue !== undefined) {
    catalogWarns.warn(
      "option",
      `experiential catalog ttl=${String(optionValue)} is invalid (non-numeric); using default ${EXPERIENTIAL_CATALOG_TTL_SECONDS}s.`,
    );
  }
  const envRaw =
    typeof envValue === "string" && envValue.trim().length > 0 ? Number(envValue) : envValue;
  const fromEnv = parseExperientialCatalogTtlSeconds(envRaw);
  if (fromEnv !== undefined) {
    if (fromEnv !== envRaw) {
      catalogWarns.warn(
        "env",
        `experiential catalog ttl=${String(envValue)} below min ${MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS}s; using ${MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS}s.`,
      );
    }
    return fromEnv;
  }
  if (envValue !== undefined) {
    catalogWarns.warn(
      "env",
      `experiential catalog ttl=${String(envValue)} is invalid (non-numeric); using default ${EXPERIENTIAL_CATALOG_TTL_SECONDS}s.`,
    );
  }
  return EXPERIENTIAL_CATALOG_TTL_SECONDS;
}

/**
 * Record one fetch outcome: a success replaces the map and arms the success
 * clock; a failure arms the backoff clock and keeps the last-good map.
 */
async function runCatalogFetch(
  catalogURL: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<Map<string, ExperientialRouteEfforts> | undefined> {
  let loaded: Map<string, ExperientialRouteEfforts> | undefined;
  try {
    loaded = await loadCatalog(catalogURL, timeoutMs, fetchImpl);
  } catch {
    loaded = undefined;
  }
  if (loaded !== undefined) {
    catalogCache.set(catalogURL, { map: loaded, at: now(), failureAt: 0 });
    return loaded;
  }
  safeFailure("experiential-catalog", "fetch");
  const previous = catalogCache.get(catalogURL);
  catalogCache.set(catalogURL, {
    map: previous?.map,
    at: previous?.at ?? 0,
    failureAt: now(),
  });
  return undefined;
}

/**
 * Fetch the catalog's default-route efforts. Never throws and never logs raw
 * error detail. Successes are reused for the success TTL (24 h default, 900 s
 * floor) and failures back off for 1 h, both independent of the models poll
 * cadence; concurrent callers share one in-flight request per URL. `bypassTtl`
 * is for the force-mode rescan command only — everything else, merge included,
 * reuses the cached map until the TTL expires.
 */
export async function fetchExperientialRouteEfforts(
  catalogURL: string,
  timeoutMs: number,
  options: ExperientialCatalogFetchOptions = {},
): Promise<ExperientialEffortsMap | undefined> {
  const now = options.now ?? Date.now;
  const entry = catalogCache.get(catalogURL);
  if (options.bypassTtl !== true && entry !== undefined) {
    const ttlSeconds = resolveExperientialCatalogTtlSeconds(
      options.ttlSeconds,
      process.env[EXPERIENTIAL_CATALOG_TTL_ENV],
    );
    if (entry.at > 0 && now() - entry.at < ttlSeconds * 1000) return entry.map;
    if (entry.failureAt > 0 && now() - entry.failureAt < CATALOG_FAILURE_BACKOFF_SECONDS * 1000) {
      return entry.map;
    }
  }
  let pending = catalogInflight.get(catalogURL);
  if (pending === undefined) {
    pending = runCatalogFetch(catalogURL, timeoutMs, options.fetchImpl ?? fetch, now);
    catalogInflight.set(catalogURL, pending);
    const clear = (): void => {
      if (catalogInflight.get(catalogURL) === pending) catalogInflight.delete(catalogURL);
    };
    void pending.then(clear, clear);
  }
  const loaded = await pending;
  return loaded ?? catalogCache.get(catalogURL)?.map;
}