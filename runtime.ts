/** Runtime wiring: config reading, polling, store auth, scheduler, watch, setup. */

// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { existsSync, readFileSync, watch } from "node:fs";
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { homedir } from "node:os";

import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  LOG_PREFIX,
  POLL_TIMEOUT_MS,
  TICK_MS,
  createWarnState,
  isRecord,
  isTruthyEnv,
  safeFailure,
  watchWarns,
} from "./core.ts";
import {
  resolveCacheForSeconds,
  resolveIntervalSeconds,
  resolvePollTimeoutSeconds,
} from "./seconds.ts";
import {
  mergeProviderConfigs,
  parseJsonc,
  parseProviders,
  resolveConfigSources,
  resolveParametersPath,
  selectAutoTargets,
  type ConfigSource,
  type ProviderConfigMap,
  type ProviderTarget,
} from "./config.ts";
import {
  buildCatalogJoin,
  discoveredModelName,
  effortVariants,
  entryMatches,
  extractEntries,
  mergeTargets,
  mergeVariants,
  parseParametersCapabilities,
  parseParametersLimit,
  reconcileOwnedModelIds,
  resolveModelMetadata,
  retainLastGood,
  type CatalogJoinCandidate,
  type CatalogProviderRecordLite,
  type ModelCapabilitiesLite,
  type ModelEntry,
  type ModelLimitLite,
  type ModelMetadata,
  type ModelVariantLite,
} from "./metadata.ts";
import {
  buildStateFile,
  loadStateFile,
  resolveStateFilePath,
  writeStateFile,
  type ProviderStateInput,
  type StateTrigger,
} from "./state.ts";

type Cleanup = CleanupLite;

interface ModelInfoRichLite extends ModelInfoLite {
  capabilities?: ModelCapabilitiesLite;
  limit?: ModelLimitLite;
  variants?: ModelVariantLite[];
}

interface CatalogProviderDraftLite {
  provider: {
    list(): readonly CatalogProviderRecordLite[];
  };
}

function runtimeConfigSources(): ConfigSource[] {
  const home =
    typeof process.env.HOME === "string" && process.env.HOME.trim().length > 0
      ? process.env.HOME
      : homedir();
  return resolveConfigSources({
    opencodeConfig: process.env.OPENCODE_CONFIG,
    opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR,
    opencodeConfigContent: process.env.OPENCODE_CONFIG_CONTENT,
    projectConfigDisabled: isTruthyEnv(
      process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    ),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    home,
    cwd: process.cwd(),
  });
}

/** Warn once for a source/problem pair; malformed sources do not block later sources. */
function warnConfigProblem(
  source: ConfigSource,
  problem: string,
  warnedProblems: Set<string>,
): void {
  const key = `${source.marker}\0${source.path ?? "inline"}\0${problem}`;
  if (warnedProblems.has(key)) return;
  warnedProblems.add(key);
  console.warn(`${LOG_PREFIX} config-${problem}: config=${source.marker}; status=unknown`);
}

function readProviderMap(
  parsed: Record<string, unknown>,
  source: ConfigSource,
  warnedProblems: Set<string>,
  field: "provider" | "providers",
): ProviderConfigMap | undefined {
  const providers = parsed[field];
  if (providers === undefined) return undefined;
  if (!isRecord(providers)) {
    warnConfigProblem(source, `malformed-${field}-map`, warnedProblems);
    return undefined;
  }

  const validProviders: ProviderConfigMap = {};
  for (const [id, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      warnConfigProblem(source, `malformed-provider-${field}`, warnedProblems);
      continue;
    }
    if (field === "providers" && isRecord(provider.settings)) {
      const { settings: _settings, ...withoutSettings } = provider;
      const options = mergeProviderConfigs([
        { [id]: { options: isRecord(provider.options) ? provider.options : {} } },
        { [id]: { options: provider.settings } },
      ])[id]?.options;
      validProviders[id] = { ...withoutSettings, options };
    } else {
      validProviders[id] = provider;
    }
  }
  return validProviders;
}

/** Read JSON/JSONC sources and merge provider config without leaking source data. */
function readAutoProviders(
  configSources: readonly ConfigSource[],
  warnedProblems: Set<string>,
): ProviderConfigMap | undefined {
  const sourceMaps: ProviderConfigMap[] = [];
  let readableConfig = false;

  for (const source of configSources) {
    let raw: string;
    if (source.kind === "content") {
      raw = source.content ?? "";
    } else {
      try {
        if (!source.path) {
          warnConfigProblem(source, "unreadable", warnedProblems);
          continue;
        }
        raw = readFileSync(source.path, "utf8");
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? (err as { code?: unknown }).code
            : undefined;
        const problem = code === "ENOENT" ? "missing" : "unreadable";
        warnConfigProblem(source, problem, warnedProblems);
        continue;
      }
    }

    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch {
      warnConfigProblem(source, "malformed-jsonc", warnedProblems);
      continue;
    }

    if (!isRecord(parsed)) {
      warnConfigProblem(source, "malformed-config", warnedProblems);
      continue;
    }
    readableConfig = true;

    const legacy = readProviderMap(parsed, source, warnedProblems, "provider");
    const native = readProviderMap(parsed, source, warnedProblems, "providers");
    const validProviders = mergeProviderConfigs(
      [legacy, native].filter((map): map is ProviderConfigMap => map !== undefined),
    );

    console.log(
      `${LOG_PREFIX} Auto-discovery config: ${Object.keys(validProviders).length} provider(s) ` +
        `(config=${source.marker}; status=unknown)`,
    );
    sourceMaps.push(validProviders);
  }

  return readableConfig ? mergeProviderConfigs(sourceMaps) : undefined;
}

function discoverAuto(
  configSources: readonly ConfigSource[],
  disabledIds: ReadonlySet<string>,
  warnedProblems: Set<string>,
  globalParametersPath?: string,
): ProviderTarget[] {
  const providers = readAutoProviders(configSources, warnedProblems);
  if (!providers) return [];

  const selection = selectAutoTargets(providers, disabledIds, process.env, globalParametersPath);
  for (const message of selection.messages) {
    const write = message.level === "warn" ? console.warn : console.log;
    write(`${LOG_PREFIX} ${message.message}`);
  }
  return selection.targets;
}

/** Per-poll parameters context: cache TTL knobs and the rescan bypass flag. */
export interface ParametersPollContext {
  readonly cacheForSeconds?: number;
  readonly intervalSeconds?: number;
  readonly bypassParameterCache?: boolean;
}

/** Per-model parameters cache: provider id + model id -> fetched parameters contributions. */
const parametersCache = new Map<
  string,
  {
    at: number;
    variants: ModelVariantLite[] | undefined;
    limit: ModelLimitLite | undefined;
    capabilities: ModelCapabilitiesLite | undefined;
  }
>();

/** Warn-once dedupe for per-provider parameters fetch problems. */
const parametersWarns = createWarnState();

/** Test-only reset of the once-per-provider parameters warning dedupe. */
export function resetWarnedParametersKeys(): void {
  parametersWarns.reset();
}

/** One per-model parameters fetch's contributions; each field may be absent. */
export interface ParametersMetadata {
  variants: ModelVariantLite[] | undefined;
  limit: ModelLimitLite | undefined;
  capabilities: ModelCapabilitiesLite | undefined;
}

/** Outcome of one per-model parameters fetch: ok contributions or skip. */
type ParametersResult = ({ ok: true } & ParametersMetadata) | { ok: false };

/**
 * Fetch one model's parameters endpoint once per TTL window. Successes (200
 * with or without contributions) are cached; failures and 404s are not, so a
 * late-arriving model's parameters are retried next cycle. One fetch can serve
 * three contributions: effort variants, limit, and capabilities.
 */
async function loadParametersMetadata(
  target: ProviderTarget,
  modelID: string,
  headers: Record<string, string>,
  timeoutMs: number,
  context: ParametersPollContext,
): Promise<ParametersResult> {
  const cacheKey = `${target.id}\0${modelID}`;
  const ttlSeconds =
    target.cacheForSeconds ??
    target.intervalSeconds ??
    context.cacheForSeconds ??
    context.intervalSeconds ??
    300;
  const cached = parametersCache.get(cacheKey);
  if (cached !== undefined && !context.bypassParameterCache && Date.now() - cached.at < ttlSeconds * 1000) {
    return {
      ok: true,
      variants: cached.variants,
      limit: cached.limit,
      capabilities: cached.capabilities,
    };
  }
  let response: Response;
  try {
    const url = new URL(target.parametersPath as string, target.baseURL);
    url.searchParams.set("model", modelID);
    response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    parametersWarns.warn(target.id, `Provider "${target.id}": parameters fetch failed; skipping.`);
    return { ok: false };
  }
  if (!response.ok) {
    parametersWarns.warn(target.id, `Provider "${target.id}": parameters fetch failed; skipping.`);
    return { ok: false };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    parametersWarns.warn(
      target.id,
      `Provider "${target.id}": parameters response unparsable; skipping.`,
    );
    return { ok: false };
  }
  const record = isRecord(body) ? body : undefined;
  const contributions: ParametersMetadata = record
    ? {
        variants: effortVariants(record.reasoning_effort_levels),
        limit: parseParametersLimit(record),
        capabilities: parseParametersCapabilities(record),
      }
    : { variants: undefined, limit: undefined, capabilities: undefined };
  parametersCache.set(cacheKey, { at: Date.now(), ...contributions });
  return { ok: true, ...contributions };
}

/**
 * Poll one provider. Undefined result means keep the previous discovered list.
 * Timeout precedence: the target's per-provider pollTimeoutMs (auto targets)
 * > the caller's fallbackTimeoutMs > the 20s default. When the target opts
 * into a parameters endpoint, models still lacking effort variants after the
 * standard pass get one lazy per-model parameters fetch using the same auth;
 * that single fetch also backfills the limit and capabilities fields the
 * standard pass did not supply.
 */
export async function pollProvider(
  target: ProviderTarget,
  fallbackTimeoutMs?: number,
  parameters?: ParametersPollContext,
): Promise<ModelEntry[] | undefined> {
  const url = typeof target.pollURL === "string" ? target.pollURL : `${target.baseURL}/models`;
  const buildAuthHeaders = (): Record<string, string> => {
    const envKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
    const apiKey = envKey ?? target.apiKey ?? target.storeAuth;
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  };
  const headers: Record<string, string> = { ...(target.headers ?? {}), ...buildAuthHeaders() };
  const timeoutMs = target.pollTimeoutMs ?? fallbackTimeoutMs ?? POLL_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    safeFailure("poll", target.id);
    return undefined;
  }

  if (!response.ok) {
    safeFailure("poll", target.id, response.status);
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    safeFailure("response-parse", target.id, response.status);
    return undefined;
  }

  const entries = extractEntries(body, target.enrich === true);
  if (entries === undefined) {
    safeFailure("response-shape", target.id, response.status);
    return undefined;
  }

  const filtered = entries.filter((entry) => entryMatches(entry, target.filter));
  const result = target.enrich
    ? filtered.map((entry) => ({ ...entry, enrich: true as const }))
    : filtered;

  if (typeof target.parametersPath === "string" && target.parametersPath.length > 0) {
    for (const entry of result) {
      if (entry.metadata?.variants !== undefined) continue;
      const outcome = await loadParametersMetadata(
        target,
        entry.id,
        buildAuthHeaders(),
        timeoutMs,
        parameters ?? {},
      );
      if (outcome.ok) {
        const metadata: ModelMetadata = entry.metadata ?? {};
        const variants = mergeVariants(metadata.variants, outcome.variants);
        if (variants !== undefined) metadata.variants = variants;
        // One fetch, three contributions: the parameters result composes as a
        // provider contribution and fills only the fields the standard pass
        // did not supply (provider-rich wins per field).
        if (metadata.limit === undefined && outcome.limit !== undefined) {
          metadata.limit = outcome.limit;
        }
        if (metadata.capabilities === undefined && outcome.capabilities !== undefined) {
          metadata.capabilities = outcome.capabilities;
        }
        if (
          metadata.capabilities !== undefined ||
          metadata.limit !== undefined ||
          metadata.variants !== undefined
        ) {
          (entry as { metadata?: ModelMetadata }).metadata = metadata;
        }
      }
    }
  }

  console.log(
    `${LOG_PREFIX} Provider "${target.id}": ${result.length} model(s) discovered [${new Date().toISOString()}]`,
  );
  return result;
}

export interface ResolvedStoreCredential {
  readonly kind: "key" | "oauth";
  readonly secret: string;
}

/**
 * Resolve a provider credential from the OpenCode integration store.
 * Guarded: absent or throwing ctx.integration falls through to undefined so
 * mocks and older runtimes are unaffected. Every store await is try/caught;
 * secrets and error detail are never logged.
 */
export async function resolveIntegrationCredential(
  ctx: PluginContextLite | undefined,
  providerID: string,
  integrationID?: string,
): Promise<ResolvedStoreCredential | undefined> {
  const connection = ctx?.integration?.connection;
  if (typeof connection?.active !== "function" || typeof connection.resolve !== "function") {
    return undefined;
  }

  const resolveOnce = async (
    id: string,
  ): Promise<{ connection?: IntegrationConnectionLite; credential?: ResolvedStoreCredential }> => {
    const safe = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch {
        return undefined;
      }
    };
    const conn = await safe(() => connection.active(id));
    if (typeof conn !== "object" || conn === null || conn.type !== "credential") return {};
    const value = await safe(() => connection.resolve(conn));
    if (typeof value !== "object" || value === null) return {};
    if (value.type === "key" && typeof value.key === "string") {
      return { credential: { kind: "key", secret: value.key } };
    }
    if (value.type === "oauth" && typeof value.access === "string") {
      return { credential: { kind: "oauth", secret: value.access } };
    }
    return {};
  };

  const first = await resolveOnce(providerID);
  if (first.credential !== undefined) return first.credential;
  if (
    first.connection === undefined &&
    typeof integrationID === "string" &&
    integrationID.length > 0 &&
    integrationID !== providerID
  ) {
    return (await resolveOnce(integrationID)).credential;
  }
  return undefined;
}

/** Resolves a store credential to a plain bearer secret for one refresh cycle. */
export type StoreAuthResolver = (
  providerID: string,
  integrationID?: string,
) => Promise<string | undefined>;

/** Per-cycle store resolver: each provider id resolves at most once per cycle. */
export function createStoreAuthResolver(ctx: PluginContextLite | undefined): StoreAuthResolver {
  const cache = new Map<string, string | undefined>();
  return async (providerID: string, integrationID?: string): Promise<string | undefined> => {
    if (cache.has(providerID)) return cache.get(providerID);
    const credential = await resolveIntegrationCredential(ctx, providerID, integrationID);
    const secret = credential?.secret;
    cache.set(providerID, secret);
    return secret;
  };
}

/** Attach per-cycle store credentials to targets before polling; never logs. */
async function enrichTargetsWithStoreAuth(
  targets: readonly ProviderTarget[],
  resolveStoreAuth: StoreAuthResolver,
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      const secret = await resolveStoreAuth(target.id, target.integrationID);
      if (secret === undefined) return;
      target.storeAuth = secret;
    }),
  );
}

/**
 * Module-level immediate-refresh hook installed by setupInternal and
 * injectable in tests. The rescan command and config watcher both call
 * requestImmediateRefresh, which is a no-op when no setup is active.
 */
let immediateRefreshHook: (() => void) | undefined;

/** Fire an immediate refresh (bypassing the poll interval) if a setup is active. */
export function requestImmediateRefresh(): void {
  immediateRefreshHook?.();
}

/** Test-only injection of the immediate-refresh hook. */
export function setImmediateRefreshHook(hook: (() => void) | undefined): void {
  immediateRefreshHook = hook;
}

/** Sanitized per-cycle outcome for user-visible acks; carries no raw errors. */
export interface RefreshSummary {
  /** "complete" = cycle ran (per-provider failures are in `failed`); "error" = cycle threw. */
  outcome: "complete" | "error";
  /** Targets polled this cycle. */
  polled: number;
  /** providerID → discovered model count, successful polls only. */
  discoveredCounts: Array<[string, number]>;
  /** Provider ids whose poll failed this cycle; last-good is kept for them. */
  failed: string[];
}

/**
 * Summarize one refresh cycle from its poll results for ack surfaces.
 * `results` maps providerID → models; `undefined` marks a failed poll.
 */
export function buildRefreshSummary(
  due: readonly { id: string }[],
  results: ReadonlyMap<string, readonly ModelEntry[] | undefined>,
): RefreshSummary {
  const discoveredCounts: Array<[string, number]> = [];
  const failed: string[] = [];
  for (const target of due) {
    const models = results.get(target.id);
    if (models === undefined) failed.push(target.id);
    else discoveredCounts.push([target.id, models.length]);
  }
  return { outcome: "complete", polled: due.length, discoveredCounts, failed };
}

/** Format a rescan ack message; sanitized (ids and counts only, never errors). */
export function formatRescanAck(summary: RefreshSummary): string {
  if (summary.outcome === "error") {
    return "Models-discovery rescan failed; previous models kept. Check server logs.";
  }
  const total = summary.discoveredCounts.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    `Models-discovery rescan complete: ${total} model(s) across ${summary.discoveredCounts.length} provider(s).`,
  ];
  if (summary.failed.length > 0) {
    parts.push(`Failed, kept last known: ${summary.failed.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * Poll the due subset of the desired targets; target-less cycles refresh
 * nothing. A target is due when its interval has elapsed AND, when a cache
 * TTL is configured, its last SUCCESSFUL poll is at least that old: the TTL
 * gates on success only, so failed polls never delay their next interval
 * retry. skipInterval drops the interval gate (config-watch refresh) while
 * keeping the TTL gate.
 */
export function computeDueTargets(
  targets: readonly ProviderTarget[],
  lastPolledMs: ReadonlyMap<string, number>,
  now: number,
  globalIntervalSeconds: number = DEFAULT_POLL_INTERVAL_SECONDS,
  lastSuccessMs: ReadonlyMap<string, number> = new Map(),
  globalCacheForSeconds?: number,
  skipInterval = false,
): ProviderTarget[] {
  return targets.filter((target) => {
    const cacheForSeconds = target.cacheForSeconds ?? globalCacheForSeconds;
    if (skipInterval) {
      if (cacheForSeconds === undefined) return true;
      const lastSuccess = lastSuccessMs.get(target.id);
      return lastSuccess === undefined || now - lastSuccess >= cacheForSeconds * 1000;
    }
    const intervalSeconds = target.intervalSeconds ?? globalIntervalSeconds;
    const lastPolled = lastPolledMs.get(target.id);
    if (lastPolled !== undefined && now - lastPolled < intervalSeconds * 1000) return false;
    if (cacheForSeconds === undefined) return true;
    const lastSuccess = lastSuccessMs.get(target.id);
    return lastSuccess === undefined || now - lastSuccess >= cacheForSeconds * 1000;
  });
}

function watchErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export interface ConfigWatchHandle {
  dispose(): void;
}

/**
 * Watch resolved config files and debounce any change burst into a single
 * trigger. Nonexistent files are skipped silently; watcher errors warn once
 * per path and never crash the plugin.
 */
export function createConfigWatch(
  paths: readonly string[],
  onTrigger: () => void,
  debounceMs = 500,
): ConfigWatchHandle {
  const watchers: Array<{ path: string; close(): void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      onTrigger();
    }, debounceMs);
  };

  const warnOnce = (configPath: string): void => {
    watchWarns.warn(configPath, `config-watch: cannot watch config=${configPath}; status=unknown`);
  };

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const watcher = watch(configPath, () => schedule());
      watcher.on("error", () => warnOnce(configPath));
      watchers.push({ path: configPath, close: () => watcher.close() });
    } catch (err) {
      if (watchErrorCode(err) === "ENOENT") continue;
      warnOnce(configPath);
    }
  }

  return {
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // A watcher that already failed to close is ignored.
        }
      }
      watchers.length = 0;
    },
  };
}

async function pollAll(
  targets: readonly ProviderTarget[],
  fallbackTimeoutMs?: number,
  parameters?: ParametersPollContext,
): Promise<ReadonlyMap<string, ModelEntry[] | undefined>> {
  const results = await Promise.all(
    targets.map(async (target): Promise<readonly [string, ModelEntry[] | undefined]> => [
      target.id,
      await pollProvider(target, fallbackTimeoutMs, parameters),
    ]),
  );
  return new Map(results);
}

/**
 * Catalog transform body: read the closure map and enrich matching models.
 * Per-model try/catch: a model missing from the draft or a rejecting update
 * must not abort the remaining updates. Enrichment fields are assigned only
 * for explicitly enriched entries; ordinary entries remain name-only.
 */
export function applyDiscovered(
  draft: CatalogDraftLite,
  discovered: ReadonlyMap<string, ModelEntry[]>,
  joinCandidates: readonly CatalogJoinCandidate[] = [],
): void {
  let skipped = 0;
  for (const [providerID, models] of discovered) {
    for (const modelEntry of models) {
      try {
        const resolution =
          modelEntry.enrich === true
            ? resolveModelMetadata(providerID, modelEntry.id, modelEntry.metadata, joinCandidates)
            : { provenance: "name-only" as const };
        draft.model.update(providerID, modelEntry.id, (model) => {
          const richModel = model as ModelInfoRichLite;
          richModel.name = discoveredModelName(richModel.name, modelEntry.id, modelEntry.name);
          if (resolution.metadata?.capabilities) {
            richModel.capabilities = resolution.metadata.capabilities;
          }
          if (resolution.metadata?.limit) richModel.limit = resolution.metadata.limit;
          if (resolution.metadata?.variants) richModel.variants = resolution.metadata.variants;
        });
      } catch {
        skipped += 1;
      }
    }
  }
  if (skipped > 0) {
    safeFailure("catalog-update", "runtime");
  }
}

export async function setup(ctx: PluginContextLite): Promise<Cleanup | void> {
  try {
    return await setupInternal(ctx);
  } catch {
    safeFailure("setup", "runtime");
    return undefined;
  }
}

async function setupInternal(ctx: PluginContextLite): Promise<Cleanup | void> {
  // Parameters path precedence: plugin options > env. Per-provider overrides
  // (modelsDiscovery.parametersPath) are stored on targets at selection time.
  const globalParametersPath = resolveParametersPath(
    ctx.options.parametersPath,
    process.env.OPENCODE_MODELS_DISCOVERY_PARAMETERS_PATH,
  );
  const manual = parseProviders(ctx.options, globalParametersPath);
  for (const warning of manual.warnings) {
    console.warn(`${LOG_PREFIX} ${warning}`);
  }
  const disabledIds = manual.disabledIds;
  const manualTargets = manual.targets;
  const warnedConfigProblems = new Set<string>();
  const autoTargets = discoverAuto(
    runtimeConfigSources(),
    disabledIds,
    warnedConfigProblems,
    globalParametersPath,
  );
  let targets = mergeTargets(manualTargets, autoTargets);

  if (targets.length === 0) {
    console.log(
      `${LOG_PREFIX} No providers configured (options.providers absent/empty and no auto-discoverable providers); no-op.`,
    );
    return;
  }

  // Interval precedence: per-provider (stored on auto targets at selection
  // time) > plugin options > env > default. Manual targets use the global.
  const globalIntervalSeconds = resolveIntervalSeconds(
    undefined,
    ctx.options.intervalSeconds,
    process.env.OPENCODE_MODELS_DISCOVERY_INTERVAL_SECONDS,
  );

  // Cache TTL precedence: per-provider (stored on auto targets at selection
  // time) > plugin options > env; unset means the feature is off (today's
  // poll-on-every-interval behavior). Manual targets use the global.
  const globalCacheForSeconds = resolveCacheForSeconds(
    undefined,
    ctx.options.cacheFor,
    process.env.OPENCODE_MODELS_DISCOVERY_CACHE_FOR_SECONDS,
  );

  // Poll timeout precedence: per-provider (stored on targets at selection
  // time) > plugin options > env > 20s default. Manual targets use the global.
  const globalPollTimeoutMs =
    resolvePollTimeoutSeconds(
      undefined,
      ctx.options.pollTimeoutSeconds,
      process.env.OPENCODE_MODELS_DISCOVERY_POLL_TIMEOUT_SECONDS,
    ) * 1000;

  // Discovery state file: disk snapshot of clocks/counts (never credentials).
  // Missing/corrupt/v1-mismatched file is ignored; in-memory maps stay the
  // source of truth.
  const statePath = resolveStateFilePath();
  const persistedState = loadStateFile(statePath);

  let discovered = new Map<string, ModelEntry[]>();
  const ownedModelIds = new Map<string, Set<string>>();
  const pendingRemovals = new Map<string, Set<string>>();

  const queueRemovals = (providerID: string, modelIDs: Iterable<string>): void => {
    const existing = pendingRemovals.get(providerID) ?? new Set<string>();
    for (const modelID of modelIDs) existing.add(modelID);
    if (existing.size > 0) pendingRemovals.set(providerID, existing);
  };

  const applyPollResults = (results: ReadonlyMap<string, ModelEntry[] | undefined>): void => {
    for (const [providerID, models] of results) {
      if (models === undefined) continue;
      // Successful polls (including successful empty ones) refresh the cache
      // TTL clock; failed polls leave the last success untouched so the next
      // interval retry stays eligible. Reconcile runs only here, on actual
      // poll results, so TTL-skipped providers keep their catalog state.
      lastSuccessMs.set(providerID, Date.now());
      lastModelCounts.set(providerID, models.length);
      const previousOwned = ownedModelIds.get(providerID) ?? new Set<string>();
      const ownership = reconcileOwnedModelIds(previousOwned, models);
      queueRemovals(providerID, ownership.removed);
      const pending = pendingRemovals.get(providerID);
      if (pending) {
        for (const model of models) pending.delete(model.id);
        if (pending.size === 0) pendingRemovals.delete(providerID);
      }
      ownedModelIds.set(providerID, ownership.retained);
      discovered = retainLastGood(discovered, providerID, models);
    }
  };

  let catalogRegistration: CatalogRegistrationLite;
  try {
    catalogRegistration = await ctx.catalog.transform((draft) => {
      for (const [providerID, models] of discovered) {
        const owned = ownedModelIds.get(providerID) ?? new Set<string>();
        for (const model of models) {
          if (owned.has(model.id)) continue;
          try {
            if (draft.model.get(providerID, model.id) === undefined) owned.add(model.id);
          } catch {
            // An uncertain catalog lookup must not make an existing model removable.
          }
        }
        if (owned.size > 0) ownedModelIds.set(providerID, owned);
      }
      let joinCandidates: readonly CatalogJoinCandidate[] = [];
      try {
        joinCandidates = buildCatalogJoin(
          (draft as unknown as CatalogProviderDraftLite).provider.list(),
        );
      } catch {
        // A missing catalog snapshot keeps this rebuild name-only.
      }
      applyDiscovered(draft, discovered, joinCandidates);
      for (const [providerID, modelIDs] of pendingRemovals) {
        for (const modelID of modelIDs) {
          try {
            draft.model.remove(providerID, modelID);
          } catch {
            // Not present in the draft; ignore.
          }
        }
      }
      pendingRemovals.clear();
    });
  } catch {
    safeFailure("catalog-transform-registration", "runtime");
    return;
  }

  let latestGeneration = 0;
  let refreshQueue: Promise<RefreshSummary | undefined> = Promise.resolve(undefined);
  const lastPolledMs = new Map<string, number>();
  // Last SUCCESSFUL poll per provider; the cache TTL gates on this clock.
  const lastSuccessMs = new Map<string, number>();
  const lastModelCounts = new Map<string, number>();
  const lastTriggers = new Map<string, StateTrigger>();
  // Stamped on force cycles (rescan command); seeded from the file so a
  // non-force rewrite never erases it.
  let lastRescanAtMs: number | undefined;
  // Seed clocks from the previous run so the cache TTL is honored across
  // restarts (e.g. a 24h cacheFor keeps providers cached after a reboot), and
  // seed the discovered payloads alongside them: the catalog is process-local,
  // so a TTL-skipped boot cycle with an empty `discovered` map would upsert
  // nothing and leave registry-absent providers with zero models until the TTL
  // expires. Rehydrated entries re-apply through the same transform, so the
  // ownership/clobber guard still recomputes against the live catalog.
  if (persistedState !== null) {
    for (const [providerID, entry] of Object.entries(persistedState.providers)) {
      const successMs = Date.parse(entry.lastSuccessAt);
      if (Number.isFinite(successMs)) lastSuccessMs.set(providerID, successMs);
      const polledMs = Date.parse(entry.lastPolledAt);
      if (Number.isFinite(polledMs)) lastPolledMs.set(providerID, polledMs);
      lastModelCounts.set(providerID, entry.modelCount);
      lastTriggers.set(providerID, entry.lastTrigger);
      if (entry.models !== undefined && entry.models.length > 0) {
        discovered.set(providerID, entry.models);
      }
    }
    if (persistedState.lastRescanAt !== undefined) {
      const rescanMs = Date.parse(persistedState.lastRescanAt);
      if (Number.isFinite(rescanMs)) lastRescanAtMs = rescanMs;
    }
  }

  type RefreshMode = "normal" | "force" | "watch";

  const refreshGeneration = async (
    generation: number,
    mode: RefreshMode,
  ): Promise<RefreshSummary | undefined> => {
    try {
      const freshAutoTargets = discoverAuto(
        runtimeConfigSources(),
        disabledIds,
        warnedConfigProblems,
        globalParametersPath,
      );
      const desired = mergeTargets(manualTargets, freshAutoTargets);
      // force bypasses both interval and cache TTL (rescan command); watch skips
      // the interval gate but still respects the TTL (config-file edits); normal
      // requires the interval AND stale-or-unset TTL.
      const due =
        mode === "force"
          ? desired
          : computeDueTargets(
              desired,
              lastPolledMs,
              Date.now(),
              globalIntervalSeconds,
              lastSuccessMs,
              globalCacheForSeconds,
              mode === "watch",
            );
      // Mark attempt time BEFORE polling so failing providers never respin on
      // the next tick; a successful commit is what actually refreshes catalog.
      const attemptedAt = Date.now();
      for (const target of due) lastPolledMs.set(target.id, attemptedAt);
      const storeAuthResolver = createStoreAuthResolver(ctx);
      await enrichTargetsWithStoreAuth(due, storeAuthResolver);
      const results = await pollAll(due, globalPollTimeoutMs, {
        cacheForSeconds: globalCacheForSeconds,
        intervalSeconds: globalIntervalSeconds,
        bypassParameterCache: mode === "force",
      });
      if (generation !== latestGeneration) return undefined;

      const desiredIds = new Set(desired.map((target) => target.id));
      for (const target of targets) {
        if (desiredIds.has(target.id)) continue;
        const owned = ownedModelIds.get(target.id) ?? new Set<string>();
        queueRemovals(target.id, owned);
        ownedModelIds.delete(target.id);
        discovered.delete(target.id);
        console.log(
          `${LOG_PREFIX} Provider "${target.id}" removed from config; dropping ${owned.size} discovered model(s)`,
        );
      }
      targets = desired;
      applyPollResults(results);
      await ctx.catalog.reload();
      // Snapshot to disk once per cycle that actually polled providers: a
      // merged snapshot of ALL configured providers, so TTL-skipped ones
      // keep their clocks on disk. Failures keep their previous
      // lastSuccessMs (success-only clock); only polled providers adopt the
      // cycle trigger, the rest preserve theirs. Force cycles (rescan
      // command) stamp lastRescanAt, preserved across non-force writes. A
      // disk error must never fail the refresh.
      if (due.length > 0) {
        try {
          const trigger: StateTrigger = mode === "force" ? "command" : mode === "watch" ? "watch" : "poll";
          if (mode === "force") lastRescanAtMs = Date.now();
          const polledIds = new Set(due.map((target) => target.id));
          const entries = new Map<string, ProviderStateInput>();
          for (const target of targets) {
            const successMs = lastSuccessMs.get(target.id);
            const polledMs = lastPolledMs.get(target.id);
            if (successMs === undefined && polledMs === undefined) continue;
            const entryTrigger = polledIds.has(target.id)
              ? trigger
              : (lastTriggers.get(target.id) ?? trigger);
            entries.set(target.id, {
              lastSuccessMs: successMs,
              lastPolledMs: polledMs,
              modelCount: lastModelCounts.get(target.id) ?? 0,
              cacheForSeconds: target.cacheForSeconds ?? globalCacheForSeconds ?? null,
              lastTrigger: entryTrigger,
              // Persist the payloads too: the catalog is process-local, so a
              // restart inside the TTL rehydrates from here instead of polling.
              models: discovered.get(target.id),
            });
            lastTriggers.set(target.id, entryTrigger);
          }
          if (entries.size > 0) {
            writeStateFile(statePath, buildStateFile(entries, lastRescanAtMs));
          }
        } catch {
          safeFailure("state-file-write", "runtime");
        }
      }
      return buildRefreshSummary(due, results);
    } catch {
      safeFailure("refresh", "runtime");
      return { outcome: "error", polled: 0, discoveredCounts: [], failed: [] };
    }
  };

  const scheduleRefresh = (mode: RefreshMode = "normal"): Promise<RefreshSummary | undefined> => {
    const generation = ++latestGeneration;
    refreshQueue = refreshQueue.then(() => refreshGeneration(generation, mode));
    return refreshQueue;
  };

  /**
   * Immediate refresh bypassing interval and cache TTL; the guard dedupes
   * races. Returns the cycle's summary, or undefined when superseded.
   */
  const forceRefresh = (): Promise<RefreshSummary | undefined> => scheduleRefresh("force");

  /** Immediate refresh that still respects each target's cache TTL. */
  const watchRefresh = (): void => {
    void scheduleRefresh("watch");
  };

  // Initial poll, then rebuild the catalog so the transform runs with data.
  await scheduleRefresh();

  // One ticker loop; each tick wakes only when some target's interval elapsed.
  // Periodic refreshes stay serialized; a newer generation invalidates any
  // slow poll before its results can mutate targets, ownership, or catalog.
  const tick = (): void => {
    if (
      computeDueTargets(
        targets,
        lastPolledMs,
        Date.now(),
        globalIntervalSeconds,
        lastSuccessMs,
        globalCacheForSeconds,
      ).length > 0
    ) {
      void scheduleRefresh();
    }
  };
  const pollInterval = setInterval(tick, TICK_MS);
  immediateRefreshHook = forceRefresh;

  // Config-file watch: resolved FILE sources only; content/inline and other
  // non-file sources are skipped by construction.
  const watchedPaths = runtimeConfigSources()
    .filter((source) => source.kind === "file" && typeof source.path === "string")
    .map((source) => source.path as string);
  // Config-file edits refresh immediately but respect the cache TTL; the
  // rescan command is the documented escape that forces every target.
  const configWatch = createConfigWatch(watchedPaths, watchRefresh);

  // Command registration is best-effort: an absent or throwing command API
  // never fails setup and never spams warnings.
  let commandRegistration: { dispose(): Promise<void> | void } | undefined;
  const commandApi = ctx.command;
  if (commandApi && typeof commandApi.transform === "function") {
    try {
      commandRegistration = await commandApi.transform((draft) => {
        draft.add({
          name: "models-discovery-rescan",
          description: "Rescan discovered models now",
          execute: async (context): Promise<void> => {
            const sessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined;
            const sessionApi = ctx.session;
            // Best-effort session ack: never fail the rescan over a missing
            // session surface or a rejected synthetic post.
            const ack = (text: string): void => {
              if (sessionID === undefined) return;
              try {
                const posted = sessionApi?.synthetic?.({
                  sessionID,
                  text: `${text} [${new Date().toISOString()}]`,
                  description: "models-discovery-rescan",
                });
                if (posted && typeof posted.catch === "function") posted.catch(() => {});
              } catch {
                // Ack is cosmetic; a failing ack surface must not break the scan.
              }
            };
            ack("Models-discovery rescan started.");
            const summary = await forceRefresh();
            if (summary === undefined) {
              ack("Models-discovery rescan superseded by a newer refresh.");
              return;
            }
            ack(formatRescanAck(summary));
          },
        });
      });
    } catch {
      // Silent fail: the rescan command is a convenience, not a requirement.
    }
  }

  let cleanedUp = false;
  return async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pollInterval);
    configWatch.dispose();
    if (immediateRefreshHook === forceRefresh) immediateRefreshHook = undefined;
    try {
      await catalogRegistration.dispose();
    } catch {
      safeFailure("catalog-transform-disposal", "runtime");
    }
    if (commandRegistration !== undefined) {
      try {
        await commandRegistration.dispose();
      } catch {
        safeFailure("command-transform-disposal", "runtime");
      }
    }
  };
}
