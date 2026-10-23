/** Pure config policy: JSONC parsing, config sources, provider merge, target selection. */

// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { resolve as pathResolve } from "node:path";

import {
  MAX_PAGINATION_PAGES,
  authEnvWarns,
  cacheForWarns,
  intervalWarns,
  pollTimeoutWarns,
  isRecord,
  type AutoTargetMessage,
} from "./core.ts";
import {
  CACHE_FOR_SPEC,
  INTERVAL_SPEC,
  POLL_TIMEOUT_SPEC,
  parseProviderSecondsOption,
} from "./seconds.ts";

/** Warn once per provider id about an unset auth env var; never logs key material. */
function warnUnsetAuthEnv(
  messages: AutoTargetMessage[],
  id: string,
  source: "apiKey" | "apiKeyEnv",
  varName: string,
): void {
  authEnvWarns.warn(
    id,
    `Provider "${id}": ${source} references unset env var "${varName}"; polling without auth.`,
    messages,
  );
}

/** Pure discovery policy, parsing, and state helpers. */
export interface EnvironmentValues {
  readonly [name: string]: string | undefined;
}

export interface ProviderTarget {
  readonly id: string;
  readonly baseURL: string;
  readonly apiKeyEnv?: string;
  readonly headers?: Record<string, string>;
  readonly filter?: string;
  readonly apiKey?: string;
  /** Integration registry id; store-lookup fallback when the provider id is absent. */
  readonly integrationID?: string;
  /** Resolved from the ctx.integration credential store; never logged. */
  storeAuth?: string;
  readonly enabled?: boolean;
  /** Resolved poll URL override (only set on auto targets with modelsDiscovery.endpoint). */
  readonly pollURL?: string;
  /** Rich metadata mapping is enabled only for the explicit object opt-in. */
  readonly enrich?: true;
  /** Per-provider poll interval in seconds (auto targets only); global applies otherwise. */
  readonly intervalSeconds?: number;
  /** Per-provider success TTL in seconds (auto targets only); global applies otherwise. */
  readonly cacheForSeconds?: number;
  /** Per-provider poll timeout in milliseconds (auto targets only); global applies otherwise. */
  readonly pollTimeoutMs?: number;
  /** Per-provider parameters endpoint path (e.g. "/api/models/parameters"); global applies otherwise. */
  readonly parametersPath?: string;
  /** Poll only when a credential resolves; skips the provider otherwise. */
  readonly requireAuth?: boolean;
  /** Extra query parameters appended to every poll request. */
  readonly query?: Record<string, string>;
  /** Opt-in page walking for paginated catalogs. */
  readonly pagination?: ProviderPagination;
}

export type ProviderConfigMap = Record<string, Record<string, unknown>>;

/** Opt-in page walking for providers whose `/models` endpoint is paginated. */
export interface ProviderPagination {
  /** Query parameter holding the page number (1-based). */
  readonly pageParam: string;
  /** Query parameter holding the page size; omitted keeps the provider default. */
  readonly perPageParam?: string;
  /** Page size sent as `perPageParam`; also stops a walk on a short page. */
  readonly perPage?: number;
  /** Page cap for one poll; clamped to MAX_PAGINATION_PAGES. */
  readonly maxPages?: number;
}

/** String-valued query parameters appended to every poll request. */
function parseQueryRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([, raw]) => typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")
    .map(([key, raw]) => [key, String(raw)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Tolerant parse of `modelsDiscovery.pagination`; absent/malformed reads as off. */
function parsePagination(value: unknown): ProviderPagination | undefined {
  if (!isRecord(value)) return undefined;
  const pageParam =
    typeof value.pageParam === "string" && value.pageParam.trim() !== ""
      ? value.pageParam.trim()
      : "page";
  const perPageParam =
    typeof value.perPageParam === "string" && value.perPageParam.trim() !== ""
      ? value.perPageParam.trim()
      : undefined;
  const perPage =
    typeof value.perPage === "number" && Number.isInteger(value.perPage) && value.perPage > 0
      ? value.perPage
      : undefined;
  const maxPages =
    typeof value.maxPages === "number" && Number.isInteger(value.maxPages) && value.maxPages > 0
      ? Math.min(MAX_PAGINATION_PAGES, value.maxPages)
      : undefined;
  return {
    pageParam,
    ...(perPageParam !== undefined ? { perPageParam } : {}),
    ...(perPage !== undefined ? { perPage } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  };
}

export interface ParseProvidersResult {
  readonly targets: ProviderTarget[];
  readonly disabledIds: Set<string>;
  readonly warnings: string[];
}

export interface ConfigPathOptions {
  readonly opencodeConfig?: string;
  readonly opencodeConfigDir?: string;
  readonly opencodeConfigContent?: string;
  readonly projectConfigDisabled?: boolean;
  readonly xdgConfigHome?: string;
  readonly home: string;
  readonly cwd: string;
}

export interface ConfigSource {
  readonly kind: "file" | "content";
  readonly marker: string;
  readonly path?: string;
  readonly content?: string;
}

export interface AutoTargetSelection {
  readonly targets: ProviderTarget[];
  readonly messages: AutoTargetMessage[];
}

/** The {env:VAR} interpolation shape found in provider config apiKey fields. */
const ENV_INTERPOLATION = /^\{\s*env:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/;

/** Parse JSONC while preserving comment-like text inside JSON string literals. */
export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        withoutComments += current;
      } else {
        withoutComments += " ";
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        withoutComments += "  ";
        index += 1;
      } else {
        withoutComments += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }

    if (inString) {
      withoutComments += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      withoutComments += current;
    } else if (current === "/" && next === "/") {
      inLineComment = true;
      withoutComments += "  ";
      index += 1;
    } else if (current === "/" && next === "*") {
      inBlockComment = true;
      withoutComments += "  ";
      index += 1;
    } else {
      withoutComments += current;
    }
  }

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const current = withoutComments[index];
    if (inString) {
      withoutTrailingCommas += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      withoutTrailingCommas += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead += 1;
      if (withoutComments[lookahead] === "]" || withoutComments[lookahead] === "}") {
        continue;
      }
    }
    withoutTrailingCommas += current;
  }

  return JSON.parse(withoutTrailingCommas);
}

/** Resolve the parameters endpoint path with plugin options > env precedence. */
export function resolveParametersPath(
  optionsValue: unknown,
  envValue: unknown,
): string | undefined {
  if (typeof optionsValue === "string" && optionsValue.trim().length > 0) return optionsValue.trim();
  if (typeof envValue === "string" && envValue.trim().length > 0) return envValue.trim();
  return undefined;
}

/** Parse options.providers without logging or mutating caller-owned state. */
export function parseProviders(
  options: unknown,
  globalParametersPath?: string,
): ParseProvidersResult {
  const disabledIds = new Set<string>();
  const warnings: string[] = [];
  if (typeof options !== "object" || options === null) {
    return { targets: [], disabledIds, warnings };
  }

  const providers = (options as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return { targets: [], disabledIds, warnings };

  const targets: ProviderTarget[] = [];
  for (const entry of providers) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const enabled = typeof e.enabled === "boolean" ? e.enabled : undefined;
    if (enabled === false) {
      if (id) disabledIds.add(id);
      continue;
    }
    const baseURL = typeof e.baseURL === "string" ? e.baseURL.trim() : "";
    if (!id || !baseURL) {
      warnings.push("Skipping provider entry with missing id or baseURL");
      continue;
    }
    const apiKeyEnv = typeof e.apiKeyEnv === "string" ? e.apiKeyEnv : undefined;
    const integrationID = typeof e.integrationID === "string" ? e.integrationID : undefined;
    const filter = typeof e.filter === "string" ? e.filter : undefined;
    const parametersPath =
      typeof e.parametersPath === "string" && e.parametersPath.trim().length > 0
        ? e.parametersPath.trim()
        : globalParametersPath;
    const headers =
      typeof e.headers === "object" && e.headers !== null
        ? (e.headers as Record<string, string>)
        : undefined;
    const requireAuth = typeof e.requireAuth === "boolean" ? e.requireAuth : undefined;
    const query = parseQueryRecord(e.query);
    const pagination = parsePagination(e.pagination);
    targets.push({
      id,
      baseURL: baseURL.replace(/\/+$/, ""),
      apiKeyEnv,
      integrationID,
      headers,
      filter,
      enabled,
      ...(parametersPath ? { parametersPath } : {}),
      ...(requireAuth !== undefined ? { requireAuth } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(pagination !== undefined ? { pagination } : {}),
    });
  }
  return { targets, disabledIds, warnings };
}

/** Resolve config files in low-to-high precedence order. Duplicate paths read once. */
export function resolveConfigPaths(options: ConfigPathOptions): string[] {
  const paths: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate || candidate.trim().length === 0) return;
    const absolute = pathResolve(options.cwd, candidate);
    if (!paths.includes(absolute)) paths.push(absolute);
  };

  add(options.opencodeConfig);
  if (typeof options.xdgConfigHome === "string" && options.xdgConfigHome.trim().length > 0) {
    add(pathResolve(options.cwd, options.xdgConfigHome, "opencode", "opencode.json"));
  }
  add(pathResolve(options.cwd, options.home, ".config", "opencode", "opencode.json"));
  add(pathResolve(options.cwd, "opencode.json"));
  return paths;
}

/**
 * Resolve every supported config source from low to high precedence.
 *
 * Ordering is explicit path, config directory, XDG global, HOME global,
 * project direct files, project .opencode files, then inline content.
 * OpenCode's config directory is a directory root containing both filenames.
 */
export function resolveConfigSources(options: ConfigPathOptions): ConfigSource[] {
  const sources: ConfigSource[] = [];
  const seenPaths = new Set<string>();
  const addFile = (marker: string, candidate: string | undefined): void => {
    if (!candidate || candidate.trim().length === 0) return;
    const absolute = pathResolve(options.cwd, candidate);
    if (seenPaths.has(absolute)) return;
    seenPaths.add(absolute);
    sources.push({ kind: "file", marker, path: absolute });
  };
  const addDirectory = (marker: string, directory: string | undefined): void => {
    if (!directory || directory.trim().length === 0) return;
    const absolute = pathResolve(options.cwd, directory);
    addFile(marker, pathResolve(absolute, "opencode.json"));
    addFile(marker, pathResolve(absolute, "opencode.jsonc"));
  };

  addFile("explicit", options.opencodeConfig);
  addDirectory("config-dir", options.opencodeConfigDir);
  if (options.xdgConfigHome) {
    addDirectory("xdg", pathResolve(options.cwd, options.xdgConfigHome, "opencode"));
  }
  addDirectory("home", pathResolve(options.cwd, options.home, ".config", "opencode"));

  if (!options.projectConfigDisabled) {
    addFile("project", pathResolve(options.cwd, "opencode.json"));
    addFile("project", pathResolve(options.cwd, "opencode.jsonc"));
    addFile("project-opencode", pathResolve(options.cwd, ".opencode", "opencode.json"));
    addFile("project-opencode", pathResolve(options.cwd, ".opencode", "opencode.jsonc"));
  }

  if (options.opencodeConfigContent !== undefined) {
    sources.push({ kind: "content", marker: "inline", content: options.opencodeConfigContent });
  }
  return sources;
}

function mergeConfigValues(low: unknown, high: unknown): unknown {
  if (!isRecord(low) || !isRecord(high)) return high;
  const merged: Record<string, unknown> = { ...low };
  for (const [key, value] of Object.entries(high)) {
    merged[key] = key in merged ? mergeConfigValues(merged[key], value) : value;
  }
  return merged;
}

/** Merge provider maps from low to high precedence, recursively per provider. */
export function mergeProviderConfigs(
  configs: readonly ProviderConfigMap[],
): ProviderConfigMap {
  const merged: ProviderConfigMap = {};
  for (const config of configs) {
    for (const [id, provider] of Object.entries(config)) {
      const previous = merged[id];
      merged[id] = (mergeConfigValues(previous, provider) ?? {}) as Record<string, unknown>;
    }
  }
  return merged;
}

function providerOptions(provider: Record<string, unknown>): Record<string, unknown> {
  const options = isRecord(provider.options) ? provider.options : {};
  const settings = isRecord(provider.settings) ? provider.settings : {};
  const merged = (mergeConfigValues(options, settings) ?? {}) as Record<string, unknown>;
  if (isRecord(provider.headers)) {
    merged.headers = mergeConfigValues(merged.headers, provider.headers);
  }
  for (const key of ["baseURL", "apiKey", "apiKeyEnv", "filter", "modelsDiscovery"]) {
    if (!(key in merged) && key in provider) merged[key] = provider[key];
  }
  return merged;
}

function explicitDiscoveryFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (isRecord(value) && typeof value.enabled === "boolean") return value.enabled;
  return undefined;
}

function configuredDefault(environment: EnvironmentValues): boolean | undefined {
  const value = environment.OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Select auto targets and return log messages instead of producing side effects. */
export function selectAutoTargets(
  providers: ProviderConfigMap,
  disabledIds: ReadonlySet<string>,
  environment: EnvironmentValues,
  globalParametersPath?: string,
): AutoTargetSelection {
  const targets: ProviderTarget[] = [];
  const messages: AutoTargetMessage[] = [];

  for (const [id, p] of Object.entries(providers)) {
    if (disabledIds.has(id)) {
      messages.push({
        level: "log",
        message: `Provider "${id}" disabled via options.providers; skipping auto.`,
      });
      continue;
    }
    const opts = providerOptions(p);
    const flag = opts.modelsDiscovery;
    const explicitFlag = explicitDiscoveryFlag(flag);
    const flagEnabled = explicitFlag ?? configuredDefault(environment);
    const enrich =
      isRecord(flag) && explicitFlag !== false && flag.enrich === true
        ? true
        : undefined;
    let intervalSeconds: number | undefined;
    if (isRecord(flag)) {
      intervalSeconds = parseProviderSecondsOption(
        flag.intervalSeconds,
        INTERVAL_SPEC,
        id,
        intervalWarns,
        messages,
      );
    }

    let cacheForSeconds: number | undefined;
    if (isRecord(flag)) {
      cacheForSeconds = parseProviderSecondsOption(
        flag.cacheFor,
        CACHE_FOR_SPEC,
        id,
        cacheForWarns,
        messages,
      );
    }

    let pollTimeoutMs: number | undefined;
    if (isRecord(flag)) {
      const seconds = parseProviderSecondsOption(
        flag.pollTimeoutSeconds,
        POLL_TIMEOUT_SPEC,
        id,
        pollTimeoutWarns,
        messages,
      );
      if (seconds !== undefined) pollTimeoutMs = seconds * 1000;
    }

    let requireAuth: boolean | undefined;
    let query: Record<string, string> | undefined;
    let pagination: ProviderPagination | undefined;
    if (isRecord(flag)) {
      if (typeof flag.requireAuth === "boolean") requireAuth = flag.requireAuth;
      query = parseQueryRecord(flag.query);
      pagination = parsePagination(flag.pagination);
    }

    const matchesNpm =
      [p.npm, p.package].some(
        (value) => typeof value === "string" && value.toLowerCase().includes("openai-compatible"),
      );
    const baseURL = typeof opts.baseURL === "string" ? opts.baseURL.trim() : undefined;
    const matchesUrl = !!baseURL && /\/v1(\/|$)/.test(baseURL);

    if (flagEnabled === false) {
      messages.push({
        level: "log",
        message: `Provider "${id}": modelsDiscovery disabled; skipping.`,
      });
      continue;
    }

    if (flagEnabled === true) {
      if (!baseURL) {
        messages.push({
          level: "warn",
          message: `Provider "${id}": modelsDiscovery enabled but no baseURL; skipping.`,
        });
        continue;
      }
    } else if (explicitFlag === undefined) {
      if (!(matchesNpm || matchesUrl)) {
        messages.push({
          level: "log",
          message: `Provider "${id}": not openai-compatible (no npm match, no /v1 URL); skipping.`,
        });
        continue;
      }
      if (!baseURL) {
        messages.push({
          level: "warn",
          message: `Provider "${id}": matched but no baseURL; skipping.`,
        });
        continue;
      }
    }

    if (!baseURL) continue;

    let apiKey: string | undefined;
    if (typeof opts.apiKey === "string") {
      const match = opts.apiKey.match(ENV_INTERPOLATION);
      if (match) {
        apiKey = environment[match[1]];
        if (!apiKey) warnUnsetAuthEnv(messages, id, "apiKey", match[1]);
      } else {
        apiKey = opts.apiKey;
      }
    }

    const normalizedBaseURL = baseURL.replace(/\/+$/, "");
    let pollURL = `${normalizedBaseURL}/models`;
    if (isRecord(flag)) {
      const endpoint = flag.endpoint;
      if (typeof endpoint === "string") {
        try {
          pollURL = new URL(endpoint, normalizedBaseURL).toString();
        } catch {
          messages.push({
            level: "warn",
            message: `Provider "${id}": invalid modelsDiscovery.endpoint; using default.`,
          });
        }
      }
    }

    const headers = isRecord(opts.headers)
      ? (Object.fromEntries(
          Object.entries(opts.headers).filter(([, value]) => typeof value === "string"),
        ) as Record<string, string>)
      : undefined;
    const parametersPath =
      isRecord(flag) &&
      typeof flag.parametersPath === "string" &&
      flag.parametersPath.trim().length > 0
        ? flag.parametersPath.trim()
        : globalParametersPath;
    const apiKeyEnv = typeof opts.apiKeyEnv === "string" ? opts.apiKeyEnv : undefined;
    if (apiKeyEnv && !environment[apiKeyEnv]) {
      warnUnsetAuthEnv(messages, id, "apiKeyEnv", apiKeyEnv);
    }
    const filter = typeof opts.filter === "string" ? opts.filter : undefined;
    const integrationID =
      typeof p.integrationID === "string"
        ? p.integrationID
        : typeof opts.integrationID === "string"
          ? opts.integrationID
          : undefined;
    targets.push({
      id,
      baseURL: normalizedBaseURL,
      apiKey,
      apiKeyEnv,
      headers,
      filter,
      pollURL,
      ...(enrich ? { enrich: true as const } : {}),
      ...(integrationID ? { integrationID } : {}),
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      ...(cacheForSeconds !== undefined ? { cacheForSeconds } : {}),
      ...(pollTimeoutMs !== undefined ? { pollTimeoutMs } : {}),
      ...(parametersPath ? { parametersPath } : {}),
      ...(requireAuth !== undefined ? { requireAuth } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(pagination !== undefined ? { pagination } : {}),
    });
  }
  return { targets, messages };
}
