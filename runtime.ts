/** Runtime wiring: config reading, polling, store auth, scheduler, watch, setup. */

// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { existsSync, readFileSync, watch } from "node:fs";
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { homedir } from "node:os";

import {
  DEFAULT_PAGINATION_MAX_PAGES,
  DEFAULT_POLL_INTERVAL_SECONDS,
  LOG_PREFIX,
  MAX_PAGINATION_PAGES,
  POLL_TIMEOUT_MS,
  POLL_TOTAL_TIMEOUT_MULTIPLIER,
  TICK_MS,
  createWarnState,
  errorName,
  isRecord,
  isTruthyEnv,
  resolveBackgroundBoot,
  resolveBackgroundDeferMs,
  safeFailure,
  watchWarns,
} from "./core.ts";
import {
  resolveAuthBackoffSeconds,
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
  applyMetadataGapFill,
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
  registryJoinVariants,
  resolveModelMetadata,
  retainLastGood,
  type CatalogJoinCandidate,
  type CatalogProviderRecordLite,
  type ModelCapabilitiesLite,
  type ModelEntry,
  type ModelEnrichmentResolution,
  type ModelLimitLite,
  type ModelMetadata,
  type ModelVariantLite,
} from "./metadata.ts";
import {
  buildStateFile,
  consumeTriggerFile,
  loadStateFile,
  mergedModelIdsFor,
  resolveStateFilePath,
  resolveTriggerFilePath,
  withMergedModelIds,
  writeStateFile,
  type ProviderStateError,
  type ProviderStateInput,
  type StateTrigger,
} from "./state.ts";
import {
  experientialCatalogURL,
  fetchExperientialRouteEfforts,
} from "./experiential.ts";

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

/** Resolved catalog write surface: one build spans the legacy and split APIs. */
interface CatalogSurface {
  /** Which host surface won: "model" (v2.0.4+ split) or "catalog" (legacy). */
  readonly kind: "model" | "catalog";
  transform(body: (draft: CatalogDraftLite) => void): Promise<CatalogRegistrationLite>;
  reload(): Promise<void>;
}

/**
 * Adapt a v2.0.4+ model-namespace draft to the legacy CatalogDraftLite shape
 * the transform body is written against: the model methods live on the draft
 * itself there, with the provider namespace under `draft.provider`.
 */
function adaptModelDraft(draft: unknown): CatalogDraftLite {
  if (!isRecord(draft)) throw new Error("empty-draft");
  const model = {
    get: (providerID: string, modelID: string) =>
      (draft as CatalogDraftLite["model"]).get?.(providerID, modelID),
    update: (providerID: string, modelID: string, update: (model: ModelInfoLite) => void) =>
      (draft as CatalogDraftLite["model"]).update(providerID, modelID, update),
    remove: (providerID: string, modelID: string) =>
      (draft as CatalogDraftLite["model"]).remove?.(providerID, modelID),
  };
  const provider = isRecord(draft.provider) ? draft.provider : undefined;
  return {
    model: model as CatalogDraftLite["model"],
    ...(provider !== undefined
      ? { provider: provider as NonNullable<CatalogDraftLite["provider"]> }
      : {}),
  };
}

/**
 * Resolve the catalog write surface, newest first: v2.0.4+ `ctx.model`
 * (verified live on 2.0.4 — `ctx.catalog` is undefined there), then the legacy
 * `ctx.catalog` (beta line through v2.0.3). Undefined means poll-only mode:
 * discovery, state snapshots, and the rescan command keep working, but nothing
 * can reach the catalog until a known surface appears.
 */
export function resolveCatalogSurface(ctx: PluginContextLite | undefined): CatalogSurface | undefined {
  const model = ctx?.model;
  if (typeof model?.transform === "function") {
    const transform = model.transform.bind(model);
    const reload = model.reload?.bind(model);
    return {
      kind: "model",
      transform: (body) => transform((draft) => body(adaptModelDraft(draft))),
      reload: async () => {
        if (reload !== undefined) await reload();
      },
    };
  }
  const catalog = ctx?.catalog;
  if (typeof catalog?.transform === "function") {
    const transform = catalog.transform.bind(catalog);
    const reload = catalog.reload?.bind(catalog);
    return {
      kind: "catalog",
      transform: (body) => transform(body),
      reload: async () => {
        if (reload !== undefined) await reload();
      },
    };
  }
  return undefined;
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
): { targets: ProviderTarget[]; providers: ProviderConfigMap | undefined } {
  const providers = readAutoProviders(configSources, warnedProblems);
  if (!providers) return { targets: [], providers: undefined };

  const selection = selectAutoTargets(providers, disabledIds, process.env, globalParametersPath);
  for (const message of selection.messages) {
    const write = message.level === "warn" ? console.warn : console.log;
    write(`${LOG_PREFIX} ${message.message}`);
  }
  return { targets: selection.targets, providers };
}

/** Per-poll parameters context: cache TTL knobs and the rescan bypass flag. */
export interface ParametersPollContext {
  readonly cacheForSeconds?: number;
  readonly intervalSeconds?: number;
  readonly bypassParameterCache?: boolean;
  /** Force-mode (rescan command) bypass for the experiential catalog TTL. */
  readonly bypassCatalogTtl?: boolean;
  /** Sanitized per-provider failure sink for acks and the state file. */
  readonly onFailure?: (providerID: string, failure: PollFailure) => void;
}

/** Sanitized poll failure: a marker plus an HTTP status when one exists. */
export interface PollFailure {
  readonly marker: string;
  readonly status?: number;
}

/** A poll failure attributed to one provider id (ack/state surfaces). */
export interface ProviderPollFailure extends PollFailure {
  readonly providerID: string;
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
 * Stall guard for one HTTP exchange. The timer aborts only after `stallMs` with
 * no progress (headers or body bytes); a hard ceiling of
 * POLL_TOTAL_TIMEOUT_MULTIPLIER x stallMs still stops a slow-drip body from
 * holding the serialized refresh queue open.
 */
interface StallGuard {
  readonly signal: AbortSignal;
  /** Reset the inactivity window after progress. */
  readonly arm: () => void;
  /** Clear both timers once the exchange is done. */
  readonly release: () => void;
  /** Why the guard aborted, if it did. */
  readonly reason: () => "stall" | "total" | undefined;
}

function createStallGuard(stallMs: number): StallGuard {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason: "stall" | "total" | undefined;
  const total = setTimeout(() => {
    if (reason === undefined) reason = "total";
    controller.abort();
  }, stallMs * POLL_TOTAL_TIMEOUT_MULTIPLIER);
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (reason === undefined) reason = "stall";
      controller.abort();
    }, stallMs);
  };
  arm();
  return {
    signal: controller.signal,
    arm,
    release: () => {
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(total);
    },
    reason: () => reason,
  };
}

/**
 * Read the body under the stall guard and parse it. Returns `{ok:false}` for
 * both an aborted read and malformed JSON; the caller separates them with
 * `guard.reason()` so an abort never reads as a parse error.
 */
async function readResponseJson(
  response: Response,
  guard: StallGuard,
): Promise<{ ok: true; value: unknown } | { ok: false; phase: "read" | "parse" }> {
  let text = "";
  let bytes = 0;
  try {
    const body = response.body;
    if (body !== null && typeof body?.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        guard.arm();
        if (chunk.value !== undefined) {
          bytes += chunk.value.byteLength;
          text += decoder.decode(chunk.value, { stream: true });
        }
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      bytes = text.length;
    }
  } catch {
    return { ok: false, phase: "read" };
  }
  // A body shorter than its declared Content-Length is a truncated transfer,
  // not malformed JSON — report the transport, not the parser.
  const declared = Number(response.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > 0 && bytes < declared) {
    return { ok: false, phase: "read" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, phase: "parse" };
  }
}

/** Outcome of one page fetch: parsed JSON or a sanitized failure marker. */
type PageOutcome =
  | { readonly ok: true; readonly value: unknown; readonly status: number }
  | {
      readonly ok: false;
      readonly marker: string;
      readonly status?: number;
      /** True for malformed JSON (as opposed to an abort or a non-2xx). */
      readonly parseFailed: boolean;
    };

async function fetchModelsPage(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<PageOutcome> {
  const guard = createStallGuard(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: guard.signal });
  } catch {
    const timedOut = guard.reason() !== undefined;
    guard.release();
    return { ok: false, marker: timedOut ? "poll-timeout" : "poll", parseFailed: false };
  }
  if (!response.ok) {
    guard.release();
    return { ok: false, marker: "status", status: response.status, parseFailed: false };
  }
  const parsed = await readResponseJson(response, guard);
  const timedOut = guard.reason() !== undefined;
  guard.release();
  if (!parsed.ok) {
    if (timedOut) {
      return { ok: false, marker: "poll-timeout", status: response.status, parseFailed: false };
    }
    // A read failure (connection cut mid-body) is a transport problem, not
    // malformed JSON; only an actual JSON.parse failure is response-parse.
    if (parsed.phase === "read") {
      return { ok: false, marker: "poll", status: response.status, parseFailed: false };
    }
    return { ok: false, marker: "response-parse", status: response.status, parseFailed: true };
  }
  return { ok: true, value: parsed.value, status: response.status };
}

/** Apply configured query parameters and pagination to one poll URL. */
function buildPollURL(base: string, target: ProviderTarget, page: number): string {
  const pagination = target.pagination;
  if (target.query === undefined && pagination === undefined) return base;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  for (const [key, value] of Object.entries(target.query ?? {})) {
    url.searchParams.set(key, value);
  }
  if (pagination !== undefined) {
    if (pagination.perPage !== undefined && pagination.perPageParam !== undefined) {
      url.searchParams.set(pagination.perPageParam, String(pagination.perPage));
    }
    url.searchParams.set(pagination.pageParam, String(page));
  }
  return url.toString();
}

/**
 * Poll one provider. Undefined result means keep the previous discovered list.
 * Timeout precedence: the target's per-provider pollTimeoutMs (auto targets)
 * > the caller's fallbackTimeoutMs > the 20s default. The timeout is a STALL
 * window (abort only after this long with no bytes) with a hard ceiling of
 * POLL_TOTAL_TIMEOUT_MULTIPLIER x this value for the whole exchange.
 * When the target opts into pagination, pages are walked until a short/empty
 * page, the page cap, or a repeated page. When the target opts into a
 * parameters endpoint, models still lacking effort variants after the
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
  const report = (marker: string, status?: number): void => {
    parameters?.onFailure?.(
      target.id,
      status === undefined ? { marker } : { marker, status },
    );
  };

  const pagination = target.pagination;
  const maxPages =
    pagination === undefined
      ? 1
      : Math.min(
          MAX_PAGINATION_PAGES,
          Math.max(1, Math.trunc(pagination.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES)),
        );
  const collected: ModelEntry[] = [];
  const seenIds = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const pageURL = buildPollURL(url, target, page);
    const outcome = await fetchModelsPage(pageURL, headers, timeoutMs);
    if (!outcome.ok) {
      // Any page failure fails the poll: a partial multi-page catalog would
      // read as "these models vanished" and remove them from the catalog.
      if (outcome.parseFailed && page > 1) {
        safeFailure("pagination", target.id, outcome.status);
      } else {
        safeFailure(
          outcome.marker === "status" || outcome.marker === "poll-timeout" ? "poll" : outcome.marker,
          target.id,
          outcome.status,
        );
      }
      report(outcome.marker, outcome.status);
      return undefined;
    }

    const entries = extractEntries(outcome.value, target.enrich === true);
    if (entries === undefined) {
      safeFailure("response-shape", target.id, outcome.status);
      report("response-shape", outcome.status);
      return undefined;
    }
    let added = 0;
    for (const entry of entries) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      collected.push(entry);
      added += 1;
    }
    if (pagination === undefined) break;
    // Stop on an empty page, a short page (a full-size page means "more"), or
    // a page that only repeated ids already seen (providers that ignore the
    // page parameter would otherwise be fetched maxPages times).
    if (entries.length === 0 || added === 0) break;
    if (pagination.perPage !== undefined && entries.length < pagination.perPage) break;
  }

  const filtered = collected.filter((entry) => entryMatches(entry, target.filter));
  const result = target.enrich
    ? filtered.map((entry) => ({ ...entry, enrich: true as const }))
    : filtered;

  // Experiential Labs public catalog: the gateway's bare /models listing gets
  // effort data from one keyless catalog lookup per poll (never per entry),
  // only for enrich-enabled targets on that exact host. A catalog failure
  // never fails the poll: models still return with whatever metadata they had.
  if (target.enrich === true) {
    const catalogURL = experientialCatalogURL(target.baseURL);
    if (catalogURL !== undefined) {
      const routeEfforts = await fetchExperientialRouteEfforts(catalogURL, timeoutMs, {
        bypassTtl: parameters?.bypassCatalogTtl === true,
      });
      if (routeEfforts !== undefined) {
        for (const entry of result) {
          const route = routeEfforts.get(entry.id);
          if (route === undefined) continue;
          const metadata: ModelMetadata = entry.metadata ?? {};
          if (route.denied) {
            // Explicit deny: the default route declares no usable efforts, so
            // guessed models.dev join variants must not be presented for it.
            metadata.reasoningDenied = true;
          } else {
            const variants = mergeVariants(metadata.variants, effortVariants(route.efforts));
            if (variants !== undefined) metadata.variants = variants;
          }
          (entry as { metadata?: ModelMetadata }).metadata = metadata;
        }
      }
    }
  }

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

/** models.dev public registry entry slices the merge path needs. */
interface ModelsDevProviderLite {
  readonly api?: string;
  readonly env?: readonly string[];
  readonly models?: Readonly<Record<string, unknown>>;
}

/**
 * Process-global cache slot: a plugin module re-eval ("opencode reload") must
 * not reset the registry cache — a module-scope counter was observed resetting
 * on reload (v2.0.17, 2026-09-26).
 */
interface ModelsDevCacheHost {
  __opencodeModelsDiscoveryRegistry?: Promise<ReadonlyMap<string, ModelsDevProviderLite>>;
}
const modelsDevCacheHost = globalThis as ModelsDevCacheHost;

/**
 * Fetch the public models.dev provider registry (api.json) at most once per
 * process and cache it in memory — never refetched per cycle. Field `api` is
 * the OpenAI-compatible base URL (197/223 providers carry it; verified live
 * 2026-09-26); `models` powers the cross-provider effort join. Any failure
 * resolves to an empty map; never logs, never throws.
 */
function loadModelsDevProviders(): Promise<ReadonlyMap<string, ModelsDevProviderLite>> {
  if (modelsDevCacheHost.__opencodeModelsDiscoveryRegistry === undefined) {
    modelsDevCacheHost.__opencodeModelsDiscoveryRegistry = fetch("https://models.dev/api.json")
      .then(async (response): Promise<ReadonlyMap<string, ModelsDevProviderLite>> => {
        if (!response.ok) return new Map();
        const body: unknown = await response.json();
        if (!isRecord(body)) return new Map();
        const providers = new Map<string, ModelsDevProviderLite>();
        for (const [id, entry] of Object.entries(body)) {
          if (!isRecord(entry)) continue;
          const api = typeof entry.api === "string" ? entry.api : undefined;
          const env =
            Array.isArray(entry.env) && entry.env.every((name) => typeof name === "string")
              ? (entry.env as readonly string[])
              : undefined;
          const models = isRecord(entry.models)
            ? (entry.models as Readonly<Record<string, unknown>>)
            : undefined;
          providers.set(id, {
            ...(api !== undefined ? { api } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(models !== undefined ? { models } : {}),
          });
        }
        return providers;
      })
      .catch(() => new Map());
  }
  return modelsDevCacheHost.__opencodeModelsDiscoveryRegistry;
}

/** Test-only: pre-populate the process-global registry cache (no network). */
export function setModelsDevRegistryForTests(
  registry: ReadonlyMap<string, ModelsDevProviderLite> | undefined,
): void {
  if (registry === undefined) {
    delete modelsDevCacheHost.__opencodeModelsDiscoveryRegistry;
  } else {
    modelsDevCacheHost.__opencodeModelsDiscoveryRegistry = Promise.resolve(registry);
  }
}

/**
 * Synthesize a merge target for a NATIVE provider (models.dev rows, no config
 * entry): baseURL from the registry `api` field, apiKeyEnv from its env hint,
 * integrationID from the live catalog provider record. Undefined when the
 * registry has no usable api base for the id.
 */
function buildNativeMergeTarget(
  providerID: string,
  integrationID: string | undefined,
  registry: ReadonlyMap<string, ModelsDevProviderLite>,
): ProviderTarget | undefined {
  const entry = registry.get(providerID);
  const api = entry?.api;
  if (api === undefined || api.trim() === "") return undefined;
  const apiKeyEnv =
    entry?.env !== undefined && entry.env.length > 0 && entry.env[0] !== undefined && entry.env[0].trim() !== ""
      ? entry.env[0]
      : undefined;
  return {
    id: providerID,
    baseURL: api.trim().replace(/\/+$/, ""),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(integrationID !== undefined ? { integrationID } : {}),
  };
}

/** Dependencies for the no-argument merge path: inferred provider or all targets. */
interface MergeNoArgDeps {
  readonly sessionApi: PluginContextLite["session"] | undefined;
  readonly sessionID: string | undefined;
  readonly targetIds: ReadonlySet<string>;
  readonly catalogProviderInfo: ReadonlyMap<string, string | undefined>;
  readonly configTargetCount: number;
  readonly runMerge: (
    label: string,
    providerFilter: ReadonlySet<string> | undefined,
    extraTargets?: readonly ProviderTarget[],
  ) => Promise<void>;
  /** Assign the models.dev snapshot before the merge cycle (the join reads it). */
  readonly setRegistry: (registry: ReadonlyMap<string, ModelsDevProviderLite>) => void;
}

/**
 * No-argument merge: infer the provider from the session's ACTIVE model
 * (sanctioned read: ctx.session.get -> SessionInfo.model, v2.0.17); fall back
 * to merging all config targets. Module-level so the command closure stays
 * under the complexity gate.
 */
async function runMergeNoArg(deps: MergeNoArgDeps): Promise<void> {
  const activeModel = await resolveActiveSessionModel(deps.sessionApi, deps.sessionID);
  const providerID = activeModel?.providerID;
  if (
    providerID !== undefined &&
    activeModel !== undefined &&
    (deps.targetIds.has(providerID) || deps.catalogProviderInfo.has(providerID))
  ) {
    const registry = await loadModelsDevProviders();
    deps.setRegistry(registry);
    if (deps.targetIds.has(providerID)) {
      await deps.runMerge(
        `the active model ${activeModel.id} on provider "${providerID}"`,
        new Set([providerID]),
      );
      return;
    }
    const nativeTarget = buildNativeMergeTarget(
      providerID,
      deps.catalogProviderInfo.get(providerID),
      registry,
    );
    if (nativeTarget !== undefined) {
      await deps.runMerge(
        `the active model ${activeModel.id} on native provider "${providerID}"`,
        new Set([providerID]),
        [nativeTarget],
      );
      return;
    }
  }
  deps.setRegistry(await loadModelsDevProviders());
  await deps.runMerge(
    `all ${deps.configTargetCount} config provider(s): ${[...deps.targetIds].join(", ")}`,
    undefined,
  );
}

/**
 * Resolve the session's active model via the sanctioned ctx.session.get read
 * (SessionInfo.model = {id, providerID, variant?}, v2.0.17). Undefined when
 * headless, unreadable, unset, or malformed — callers fall back.
 */
async function resolveActiveSessionModel(
  sessionApi: PluginContextLite["session"] | undefined,
  sessionID: string | undefined,
): Promise<{ id: string; providerID: string } | undefined> {
  if (sessionID === undefined) return undefined;
  try {
    const info = await sessionApi?.get?.({ sessionID });
    const model = (info as { model?: { id?: unknown; providerID?: unknown } } | undefined)?.model;
    if (
      typeof model?.id !== "string" ||
      model.id === "" ||
      typeof model.providerID !== "string" ||
      model.providerID === ""
    ) {
      return undefined;
    }
    return { id: model.id, providerID: model.providerID };
  } catch {
    // Best-effort inference: an unreadable session falls back to merge-all.
  }
  return undefined;
}

/**
 * Best-effort synthetic session ack: never throws, never rejects.
 * `resume: false` keeps the note inbox-only — it never schedules a run.
 */
function postSyntheticAck(
  sessionApi: PluginContextLite["session"] | undefined,
  sessionID: string | undefined,
  description: string,
  text: string,
): void {
  if (sessionID === undefined) return;
  try {
    const posted = sessionApi?.synthetic?.({
      sessionID,
      text: `${text} [${new Date().toISOString()}]`,
      description,
      resume: false,
    });
    if (posted && typeof posted.catch === "function") posted.catch(() => {});
  } catch {
    // Ack is cosmetic; a failing ack surface must not break the scan.
  }
}

/**
 * True when a credential resolves for this poll: config apiKey, a set
 * apiKeyEnv, or a store credential attached this cycle. A provider that
 * declares no credential at all reads as false, so `requireAuth` skips it.
 */
function hasResolvedAuth(target: ProviderTarget): boolean {
  if (target.apiKey !== undefined && target.apiKey !== "") return true;
  if (target.storeAuth !== undefined && target.storeAuth !== "") return true;
  if (target.apiKeyEnv !== undefined) {
    const value = process.env[target.apiKeyEnv];
    return value !== undefined && value !== "";
  }
  return false;
}

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
  /** Targets polled this cycle (skipped targets are not counted). */
  polled: number;
  /** providerID → discovered model count, successful polls only. */
  discoveredCounts: Array<[string, number]>;
  /** Provider ids whose poll failed this cycle; last-good is kept for them. */
  failed: string[];
  /** Sanitized markers for failed providers (ids, markers, statuses only). */
  failures?: ProviderPollFailure[];
  /** Provider ids that already had models before this cycle. */
  withModels?: string[];
  /** Provider ids skipped because requireAuth found no credential. */
  skipped?: string[];
}

/** Extra per-cycle context the ack surfaces can render. */
export interface RefreshSummaryExtras {
  readonly failures?: readonly ProviderPollFailure[];
  readonly withModels?: readonly string[];
  readonly skipped?: readonly string[];
}

/**
 * Summarize one refresh cycle from its poll results for ack surfaces.
 * `results` maps providerID → models; `undefined` marks a failed poll.
 */
export function buildRefreshSummary(
  due: readonly { id: string }[],
  results: ReadonlyMap<string, readonly ModelEntry[] | undefined>,
  extras?: RefreshSummaryExtras,
): RefreshSummary {
  const discoveredCounts: Array<[string, number]> = [];
  const failed: string[] = [];
  const skippedIds = new Set(extras?.skipped ?? []);
  for (const target of due) {
    if (skippedIds.has(target.id)) continue;
    const models = results.get(target.id);
    if (models === undefined) failed.push(target.id);
    else discoveredCounts.push([target.id, models.length]);
  }
  return {
    outcome: "complete",
    polled: due.length - (extras?.skipped?.length ?? 0),
    discoveredCounts,
    failed,
    ...(extras?.failures !== undefined ? { failures: [...extras.failures] } : {}),
    ...(extras?.withModels !== undefined ? { withModels: [...extras.withModels] } : {}),
    ...(extras?.skipped !== undefined ? { skipped: [...extras.skipped] } : {}),
  };
}

/**
 * Sanitized failure detail: provider id plus marker and HTTP status when one
 * exists (`cbcn (status=401)`, `featherless (poll-timeout)`). Key material,
 * URLs, and response bodies never reach this string.
 */
function failureDetails(summary: RefreshSummary): string[] {
  const failed = new Set(summary.failed);
  return (summary.failures ?? [])
    .filter((failure) => failed.has(failure.providerID))
    .map((failure) => {
      if (failure.status === undefined) return `${failure.providerID} (${failure.marker})`;
      // An HTTP status is the whole story for a non-2xx; avoid "status, status=".
      if (failure.marker === "status") return `${failure.providerID} (status=${failure.status})`;
      return `${failure.providerID} (${failure.marker}, status=${failure.status})`;
    });
}

/** Failure clauses shared by the rescan and merge acks. */
function failureClauses(summary: RefreshSummary): string[] {
  const parts: string[] = [];
  if (summary.failed.length > 0) {
    if (summary.withModels !== undefined) {
      // Distinguish "kept last known" from "failed with nothing to keep": the
      // old wording implied stale models were retained when none existed.
      const withModels = new Set(summary.withModels);
      const kept = summary.failed.filter((id) => withModels.has(id));
      const none = summary.failed.filter((id) => !withModels.has(id));
      if (kept.length > 0) parts.push(`Failed, kept last known: ${kept.join(", ")}.`);
      if (none.length > 0) parts.push(`Failed, no previous models: ${none.join(", ")}.`);
    } else {
      parts.push(`Failed, kept last known: ${summary.failed.join(", ")}.`);
    }
  }
  const details = failureDetails(summary);
  if (details.length > 0) parts.push(`Failures: ${details.join("; ")}.`);
  if (summary.skipped !== undefined && summary.skipped.length > 0) {
    parts.push(`Skipped (no credentials): ${summary.skipped.join(", ")}.`);
  }
  return parts;
}

/** Format a rescan ack message; sanitized (ids, markers, and counts only). */
export function formatRescanAck(summary: RefreshSummary): string {
  if (summary.outcome === "error") {
    return "Models-discovery rescan failed; previous models kept. Check server logs.";
  }
  const total = summary.discoveredCounts.reduce((sum, [, count]) => sum + count, 0);
  return [
    `Models-discovery rescan complete: ${total} model(s) across ${summary.discoveredCounts.length} provider(s).`,
    ...failureClauses(summary),
  ].join(" ");
}

/** Format a merge ack message; sanitized (ids, markers, and counts only). */
export function formatMergeAck(summary: RefreshSummary): string {
  if (summary.outcome === "error") {
    return "Models-discovery merge failed; previous models kept. Check server logs.";
  }
  const total = summary.discoveredCounts.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    `Models-discovery merge complete: ${total} model(s) across ${summary.discoveredCounts.length} provider(s) checked for missing metadata.`,
    ...failureClauses(summary),
  ];
  // The TUI caches the resolved model at selection time (verified v2.0.17):
  // the picker must be reopened to see newly gap-filled efforts. The "if a
  // TUI is open" clause keeps it honest for headless sessions.
  parts.push("Reopen the TUI model picker (if a TUI is open) to see the new efforts.");
  return parts.join(" ");
}

/**
 * Poll the due subset of the desired targets; target-less cycles refresh
 * nothing. A target is due when its interval has elapsed AND, when a cache
 * TTL is configured, its last SUCCESSFUL poll is at least that old: the TTL
 * gates on success only, so failed polls never delay their next interval
 * retry. skipInterval drops the interval gate (config-watch refresh) while
 * keeping the TTL gate. `blockedUntilMs` pauses providers after an auth
 * failure (401/403) until the deadline passes.
 */
export function computeDueTargets(
  targets: readonly ProviderTarget[],
  lastPolledMs: ReadonlyMap<string, number>,
  now: number,
  globalIntervalSeconds: number = DEFAULT_POLL_INTERVAL_SECONDS,
  lastSuccessMs: ReadonlyMap<string, number> = new Map(),
  globalCacheForSeconds?: number,
  skipInterval = false,
  blockedUntilMs: ReadonlyMap<string, number> = new Map(),
): ProviderTarget[] {
  return targets.filter((target) => {
    const blockedUntil = blockedUntilMs.get(target.id);
    if (blockedUntil !== undefined && blockedUntil > now) return false;
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

/** Merge-cycle discovery entry: the transform gap-fills it instead of overriding. */
type MergeModelEntry = ModelEntry & MergeEntryFlagLite;

/** Optional merge context for applyDiscovered. */
interface MergeContext {
  /** Per-provider catalog row ids this plugin gap-filled; replays re-apply. */
  readonly mergedModelIds?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Q5/Q6 guard: return true to skip gap-fill for this row. */
  readonly isConfigBlocked?: (providerID: string, modelID: string) => boolean;
  /** Cross-provider effort join from the models.dev registry snapshot. */
  readonly registryJoin?: (providerID: string, modelID: string) => ModelVariantLite[] | undefined;
}

/**
 * Q5 verdict (live, v2.0.17): the host ConfigProviderPlugin registers last
 * (internal post) and its reset branch replaces variants on any hand `models`
 * entry that omits the variants key — catalog-side merge on those rows is
 * futile. Skip them. Rows WITHOUT a hand config entry (all native providers)
 * keep plugin gap-fill across rebuilds; config-declared rows keep config
 * values (config wins by host design; config-side persistence is a follow-up).
 */
function isMergeConfigBlocked(
  configBlockedModelIds: ReadonlyMap<string, ReadonlySet<string>>,
  providerID: string,
  modelID: string,
): boolean {
  const blocked = configBlockedModelIds.get(providerID);
  return blocked !== undefined && blocked.has(modelID);
}

/**
 * True when reasoning_options carry a toggle but no effort levels — the
 * registry's explicit statement that the provider exposes no efforts.
 */
function isToggleOnlyReasoning(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let hasToggle = false;
  for (const option of value) {
    if (!isRecord(option)) continue;
    if (option.type === "effort") return false;
    if (option.type === "toggle") hasToggle = true;
  }
  return hasToggle;
}

/**
 * Merge-branch registryJoin eligibility: the models.dev join may fill variants
 * only when the resolution supplied none and neither the resolution nor the
 * entry carries an explicit deny marker. An UNKNOWN route contributes no
 * marker, so candidates stay available there; a deny marker blocks the guess.
 */
function registryJoinEligible(
  resolution: ModelEnrichmentResolution | undefined,
  modelEntry: ModelEntry,
): boolean {
  if (resolution?.metadata?.variants !== undefined) return false;
  if (resolution?.metadata?.reasoningDenied === true) return false;
  if (modelEntry.metadata?.reasoningDenied === true) return false;
  return true;
}

/**
 * Catalog transform body: read the closure map and enrich matching models.
 * Per-model try/catch: a model missing from the draft or a rejecting update
 * must not abort the remaining updates. Enrichment fields are assigned only
 * for explicitly enriched entries; ordinary entries remain name-only.
 * Merge-flagged rows (and ids in the merged set) gap-fill via applyMetadataGapFill instead.
 */
export function applyDiscovered(
  draft: CatalogDraftLite,
  discovered: ReadonlyMap<string, ModelEntry[]>,
  joinCandidates: readonly CatalogJoinCandidate[] = [],
  merge?: MergeContext,
): void {
  let skipped = 0;
  for (const [providerID, models] of discovered) {
    const merged = merge?.mergedModelIds?.get(providerID);
    for (const modelEntry of models) {
      try {
        const resolution =
          modelEntry.enrich === true
            ? resolveModelMetadata(providerID, modelEntry.id, modelEntry.metadata, joinCandidates)
            : { provenance: "name-only" as const };
        // Merge semantics: entries from a merge cycle, or ids recorded in the
        // merged set (replay/restart re-apply), gap-fill instead of override.
        const mergeMode =
          (modelEntry as MergeModelEntry).merge === true || merged?.has(modelEntry.id) === true;
        const blocked = mergeMode && merge?.isConfigBlocked?.(providerID, modelEntry.id) === true;
        draft.model.update(providerID, modelEntry.id, (model) => {
          const richModel = model as ModelInfoRichLite;
          richModel.name = discoveredModelName(richModel.name, modelEntry.id, modelEntry.name);
          if (mergeMode) {
            // Blocked rows stay name-only; the guard never falls back to override.
            if (!blocked) {
              let fill = resolution;
              // Bare /models with an ambiguous (or empty) catalog join: the
              // models.dev registry join supplies effort variants other
              // providers define for the same model id. An explicit deny from
              // the provider's route catalog suppresses that guess — the route
              // is known and declares no usable efforts.
              if (registryJoinEligible(resolution, modelEntry)) {
                const joined = merge?.registryJoin?.(providerID, modelEntry.id);
                if (joined !== undefined) {
                  fill = {
                    provenance: "join",
                    metadata: { ...resolution.metadata, variants: joined },
                  };
                }
              }
              applyMetadataGapFill(richModel, fill);
            }
            return;
          }
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
  const bootT0 = Date.now();
  let bootCatMs = -1;
  let bootCmdMs = -1;
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
  const { targets: autoTargets, providers: autoProviders } = discoverAuto(
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

  // Boot mode precedence: plugin option `background` > env
  // OPENCODE_MODELS_DISCOVERY_BACKGROUND > default background. Background is
  // the default because the host gates plugin activation on setup resolving:
  // awaiting the initial poll below held that gate open for the poll's whole
  // network time and 503'd the model catalog when a provider was slow.
  const backgroundBoot = resolveBackgroundBoot(
    ctx.options.background,
    process.env.OPENCODE_MODELS_DISCOVERY_BACKGROUND,
  );
  // Background boot defers the first catalog APPLICATION past the host's
  // boot-time rebuilds: one application of a rehydrated payload costs the
  // host seconds of per-model draft writes, and the host rebuilds several
  // times while booting, so applying eagerly re-pays that on the critical
  // path. The deferred kickoff arms the body and runs the first cycle.
  const backgroundDeferMs = resolveBackgroundDeferMs(
    ctx.options.backgroundDeferMs,
    process.env.OPENCODE_MODELS_DISCOVERY_BACKGROUND_DEFER_MS,
  );
  let applying = !backgroundBoot;

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

  // requireAuth: plugin option > env > off. Per-provider
  // `modelsDiscovery.requireAuth` overrides this (parsed onto the target).
  const globalRequireAuth =
    typeof ctx.options.requireAuth === "boolean"
      ? ctx.options.requireAuth
      : isTruthyEnv(process.env.OPENCODE_MODELS_DISCOVERY_REQUIRE_AUTH);

  // Auth-failure pause: options > env > 30 min; 0 disables the pause.
  const authBackoffMs =
    resolveAuthBackoffSeconds(
      ctx.options.authBackoffSeconds,
      process.env.OPENCODE_MODELS_DISCOVERY_AUTH_BACKOFF_SECONDS,
    ) * 1000;

  // Discovery state file: disk snapshot of clocks/counts (never credentials).
  // Missing/corrupt/v1-mismatched file is ignored; in-memory maps stay the
  // source of truth.
  const statePath = resolveStateFilePath();
  const persistedState = loadStateFile(statePath);
  // Scriptable refresh: the host never dispatches `opencode run "/command"`,
  // so a trigger file next to the state file is the CLI path (see bin/).
  const triggerPath = resolveTriggerFilePath(statePath);

  let discovered = new Map<string, ModelEntry[]>();
  // Transform fast-path bookkeeping: the host re-runs the catalog transform on
  // every rebuild, and with a rehydrated payload each full application cost
  // 5-12s (1379 rows x per-model draft calls). `stateVersion` bumps whenever
  // the closure state changes (poll results, registry join); the transform
  // then skips re-application until the next change, unless a probe shows the
  // draft lost our rows.
  let stateVersion = 1;
  let appliedVersion = 0;
  const ownedModelIds = new Map<string, Set<string>>();
  const pendingRemovals = new Map<string, Set<string>>();

  const queueRemovals = (providerID: string, modelIDs: Iterable<string>): void => {
    const existing = pendingRemovals.get(providerID) ?? new Set<string>();
    for (const modelID of modelIDs) existing.add(modelID);
    if (existing.size > 0) pendingRemovals.set(providerID, existing);
  };

  // Merge gap-fill bookkeeping: per-provider catalog row ids whose missing
  // metadata this plugin gap-filled. Seeded from the state file so a restart
  // re-applies on catalog replay; replaced after each successful merge cycle.
  const mergedModelIds = new Map<string, Set<string>>();
  if (persistedState !== null) {
    for (const providerID of Object.keys(persistedState.providers)) {
      const ids = mergedModelIdsFor(persistedState, providerID);
      if (ids.length > 0) mergedModelIds.set(providerID, new Set(ids));
    }
  }

  // Q5: ids with a hand config `models` entry — the host config plugin resets
  // those rows' variants on rebuild, so merge gap-fill skips them.
  const configBlockedModelIds = new Map<string, Set<string>>();
  const rebuildConfigBlocked = (providers: ProviderConfigMap | undefined): void => {
    configBlockedModelIds.clear();
    if (providers === undefined) return;
    for (const [providerID, record] of Object.entries(providers)) {
      const models = record.models;
      if (!isRecord(models)) continue;
      const ids = new Set(Object.keys(models));
      if (ids.size > 0) configBlockedModelIds.set(providerID, ids);
    }
  };
  rebuildConfigBlocked(autoProviders);

  // Provider ids observed in the live catalog at transform time, with their
  // integration ids: native (models.dev) providers have no config entry, so
  // this map is how the merge command addresses them.
  const catalogProviderInfo = new Map<string, string | undefined>();

  // models.dev registry snapshot for the merge effort join: resolved once per
  // process, fire-and-forget at setup (no boot block) and awaited by the merge
  // command. Undefined until the fetch lands; the join contributes nothing
  // until then. Survives module re-eval via the globalThis cache slot.
  //
  // Startup replay race: on restart `mergedModelIds` is seeded from state and
  // the rehydrated rows replay through the first transform BEFORE this fetch
  // lands, so a replaying merged row keeps its registry-joined effort
  // variants missing — the join is transform-time only and never persisted in
  // state — until the next interval-gated cycle (300s default, up to cacheFor
  // with a long success TTL). Re-fire the transform once the snapshot arrives,
  // but only when there is something to join (non-empty snapshot) and the
  // registration exists. A fetch landing before registration completes is
  // covered by that initial refresh's own reload.
  let registrySnapshot: ReadonlyMap<string, ModelsDevProviderLite> | undefined;
  void loadModelsDevProviders().then((snapshot) => {
    registrySnapshot = snapshot;
    stateVersion += 1;
    if (
      snapshot.size > 0 &&
      mergedModelIds.size > 0 &&
      catalogRegistration !== undefined &&
      catalogSurface !== undefined
    ) {
      void (async () => {
        try {
          await catalogSurface.reload();
        } catch {
          safeFailure("catalog-reload", "runtime");
        }
      })();
    }
  });

  // Toggle-only suppression (provider-docs verdict): a provider whose own
  // models.dev entry declares a reasoning toggle without effort levels is an
  // explicit no — importing other providers' (gateway-side) effort lists
  // would write variants the provider's own API cannot honor.
  const toggleOnlyProviders = new Set<string>();

  const mergeContext: MergeContext = {
    mergedModelIds,
    isConfigBlocked: (providerID, modelID) =>
      isMergeConfigBlocked(configBlockedModelIds, providerID, modelID),
    registryJoin: (providerID, modelID) => {
      if (registrySnapshot === undefined) return undefined;
      const own = registrySnapshot.get(providerID)?.models?.[modelID];
      if (isRecord(own) && isToggleOnlyReasoning(own.reasoning_options)) {
        toggleOnlyProviders.add(providerID);
        return undefined;
      }
      return registryJoinVariants(providerID, modelID, registrySnapshot);
    },
  };

  const applyPollResults = (results: ReadonlyMap<string, ModelEntry[] | undefined>): void => {
    for (const [providerID, models] of results) {
      if (models === undefined) continue;
      stateVersion += 1;
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

  /** Stamp merge-cycle entries so the transform gap-fills instead of overriding. */
  const markMergeResults = (
    results: ReadonlyMap<string, ModelEntry[] | undefined>,
  ): ReadonlyMap<string, ModelEntry[] | undefined> =>
    new Map<string, ModelEntry[] | undefined>(
      [...results].map(([providerID, models]): [string, ModelEntry[] | undefined] => [
        providerID,
        models === undefined
          ? undefined
          : models.map((model): MergeModelEntry => ({ ...model, merge: true })),
      ]),
    );

  let catalogRegistration: CatalogRegistrationLite | undefined;
  const catalogSurface = resolveCatalogSurface(ctx);
  if (catalogSurface === undefined) {
    // Poll-only degradation: without a known catalog surface nothing can be
    // upserted, but discovery, state snapshots, and the rescan command stay
    // live so a future runtime (or a restarted one) recovers with warm clocks.
    console.warn(`${LOG_PREFIX} no catalog surface (ctx.model/ctx.catalog); polling only.`);
  } else {
    const bootCatT0 = Date.now();
    try {
      catalogRegistration = await catalogSurface.transform((draft) => {
      if (!applying) return;
      const applyT0 = Date.now();
      // Fast path: the closure state is already applied and a per-provider
      // probe says the draft still carries our rows -> the rebuild is a no-op
      // for this plugin. A pending removal or a state change falls through to
      // the full application below.
      if (appliedVersion === stateVersion && pendingRemovals.size === 0) {
        let intact = true;
        for (const [providerID, models] of discovered) {
          const probe = models[0];
          if (probe === undefined) continue;
          if (draft.model.get(providerID, probe.id) === undefined) {
            intact = false;
            break;
          }
        }
        if (intact) {
          console.log(`${LOG_PREFIX} transform skip v=${stateVersion} ms=${Date.now() - applyT0}`);
          return;
        }
        console.log(`${LOG_PREFIX} transform probe-miss v=${stateVersion}`);
      }
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
        const providerRecords = (draft as unknown as CatalogProviderDraftLite).provider.list();
        // Record catalog provider ids (native/models.dev included) so the
        // merge command can address providers without a config entry.
        for (const record of providerRecords) {
          if (typeof record?.provider?.id !== "string") continue;
          catalogProviderInfo.set(record.provider.id, record.provider.integrationID);
        }
        joinCandidates = buildCatalogJoin(providerRecords);
      } catch {
        // A missing catalog snapshot keeps this rebuild name-only.
      }
      applyDiscovered(draft, discovered, joinCandidates, mergeContext);
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
      appliedVersion = stateVersion;
      const applyMs = Date.now() - applyT0;
      // Post-apply probe: does the host's get() see what update() just wrote?
      let retained = "n/a";
      for (const [providerID, models] of discovered) {
        const probe = models[0];
        if (probe === undefined) continue;
        try {
          retained = String(draft.model.get(providerID, probe.id) !== undefined);
        } catch {
          retained = "throw";
        }
        break;
      }
      if (applyMs >= 30) {
        console.log(`${LOG_PREFIX} transform apply ms=${applyMs} v=${appliedVersion} retained=${retained}`);
      }
      });
    } catch (err) {
      // Degrade, don't abort: a moved host surface must never again silently
      // kill polling, state snapshots, and the rescan command. The error NAME
      // (never message/stack) keeps the sanitized-logs rule while saying
      // whether the surface moved (TypeError) or rejected us (SchemaError).
      safeFailure("catalog-transform-registration", "runtime");
      console.warn(
        `${LOG_PREFIX} catalog surface "${catalogSurface.kind}" unusable (error=${errorName(err)}); polling only.`,
      );
      catalogRegistration = undefined;
    }
    bootCatMs = Date.now() - bootCatT0;
  }

  let latestGeneration = 0;
  let refreshQueue: Promise<RefreshSummary | undefined> = Promise.resolve(undefined);
  const lastPolledMs = new Map<string, number>();
  // Last SUCCESSFUL poll per provider; the cache TTL gates on this clock.
  const lastSuccessMs = new Map<string, number>();
  const lastModelCounts = new Map<string, number>();
  const lastTriggers = new Map<string, StateTrigger>();
  // Auth-failure pause (401/403): providerID -> epoch ms until it is due again.
  // Cleared by a config-file edit, a force cycle, or a successful poll.
  const authBlockedUntil = new Map<string, number>();
  // Last sanitized failure per provider, persisted for post-hoc diagnosis.
  const lastErrorByProvider = new Map<string, ProviderStateError>();
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
      if (entry.lastError !== undefined) lastErrorByProvider.set(providerID, entry.lastError);
      if (entry.models !== undefined && entry.models.length > 0) {
        discovered.set(providerID, entry.models);
      }
    }
    if (persistedState.lastRescanAt !== undefined) {
      const rescanMs = Date.parse(persistedState.lastRescanAt);
      if (Number.isFinite(rescanMs)) lastRescanAtMs = rescanMs;
    }
  }

  type RefreshMode = "normal" | "force" | "watch" | "merge";

  const refreshGeneration = async (
    generation: number,
    mode: RefreshMode,
    providerFilter?: ReadonlySet<string>,
    extraTargets?: readonly ProviderTarget[],
  ): Promise<RefreshSummary | undefined> => {
    try {
      const { targets: freshAutoTargets, providers: freshProviders } = discoverAuto(
        runtimeConfigSources(),
        disabledIds,
        warnedConfigProblems,
        globalParametersPath,
      );
      rebuildConfigBlocked(freshProviders);
      const desired = mergeTargets(manualTargets, freshAutoTargets);
      // force bypasses both interval and cache TTL (rescan command); watch skips
      // the interval gate but still respects the TTL (config-file edits); normal
      // requires the interval AND stale-or-unset TTL.
      // Merge is force-like: bypass interval + TTL + parameters cache, with
      // an optional provider filter (merge command targets one provider).
      if (mode === "force") authBlockedUntil.clear();
      let due =
        mode === "force" || mode === "merge"
          ? providerFilter === undefined
            ? desired
            : desired.filter((target) => providerFilter.has(target.id))
          : computeDueTargets(
              desired,
              lastPolledMs,
              Date.now(),
              globalIntervalSeconds,
              lastSuccessMs,
              globalCacheForSeconds,
              mode === "watch",
              authBlockedUntil,
            );
      // Native merge targets (models.dev providers, no config entry) join the
      // due set directly; they are never part of `desired`.
      if (mode === "merge" && extraTargets !== undefined && extraTargets.length > 0) {
        due = [...due, ...extraTargets];
      }
      // Provider ids that already hold models BEFORE this cycle, so an ack can
      // say "kept last known" only where something was actually kept.
      const withModels = [...discovered]
        .filter(([, models]) => models.length > 0)
        .map(([providerID]) => providerID);
      const storeAuthResolver = createStoreAuthResolver(ctx);
      await enrichTargetsWithStoreAuth(due, storeAuthResolver);
      // requireAuth: skip providers with no resolvable credential instead of
      // importing a catalog that cannot be called (a public /models listing
      // does not mean the models are usable without a key).
      const pollable: ProviderTarget[] = [];
      const skipped: string[] = [];
      for (const target of due) {
        // The merge command is an explicit one-shot metadata fill, so it is
        // never gated by requireAuth.
        if (
          mode !== "merge" &&
          (target.requireAuth ?? globalRequireAuth) &&
          !hasResolvedAuth(target)
        ) {
          skipped.push(target.id);
          continue;
        }
        pollable.push(target);
      }
      // Mark attempt time BEFORE polling so failing (or credential-skipped)
      // providers never respin on the next tick; a successful commit is what
      // actually refreshes catalog. Skipped providers must be stamped too —
      // otherwise they stay "due" every second and spin a no-op refresh.
      const attemptedAt = Date.now();
      for (const target of due) lastPolledMs.set(target.id, attemptedAt);
      // A merge cycle polls with enrichment forced on regardless of the
      // standing flag, so gap-fill has metadata to fill from.
      const pollTargets =
        mode === "merge" ? pollable.map((target) => ({ ...target, enrich: true as const })) : pollable;
      const cycleFailures = new Map<string, PollFailure>();
      const results = await pollAll(pollTargets, globalPollTimeoutMs, {
        cacheForSeconds: globalCacheForSeconds,
        intervalSeconds: globalIntervalSeconds,
        bypassParameterCache: mode === "force" || mode === "merge",
        // The experiential catalog ignores its success TTL only for the
        // force-mode rescan command; merge reuses the cached map.
        bypassCatalogTtl: mode === "force",
        onFailure: (providerID, failure) => {
          cycleFailures.set(providerID, failure);
        },
      });
      const mergeResults = mode === "merge" ? markMergeResults(results) : results;
      if (generation !== latestGeneration) return undefined;

      // Failure bookkeeping: persist the sanitized marker for the state file
      // (console output never reaches opencode.log) and pause a provider after
      // a 401/403 so a bad key is not polled every interval forever. A success
      // clears both.
      const settledAt = Date.now();
      for (const target of pollable) {
        const failure = cycleFailures.get(target.id);
        if (failure === undefined) {
          authBlockedUntil.delete(target.id);
          lastErrorByProvider.delete(target.id);
          continue;
        }
        lastErrorByProvider.set(target.id, {
          marker: failure.marker,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          at: new Date(settledAt).toISOString(),
        });
        if ((failure.status === 401 || failure.status === 403) && authBackoffMs > 0) {
          authBlockedUntil.set(target.id, settledAt + authBackoffMs);
        }
      }

      const desiredIds = new Set(desired.map((target) => target.id));
      for (const target of targets) {
        if (desiredIds.has(target.id)) continue;
        const owned = ownedModelIds.get(target.id) ?? new Set<string>();
        queueRemovals(target.id, owned);
        ownedModelIds.delete(target.id);
        discovered.delete(target.id);
        mergedModelIds.delete(target.id);
        lastErrorByProvider.delete(target.id);
        authBlockedUntil.delete(target.id);
        console.log(
          `${LOG_PREFIX} Provider "${target.id}" removed from config; dropping ${owned.size} discovered model(s)`,
        );
      }
      targets = desired;
      applyPollResults(mergeResults);
      if (mode === "merge") {
        for (const [providerID, models] of mergeResults) {
          if (models === undefined) continue;
          mergedModelIds.set(providerID, new Set(models.map((model) => model.id)));
        }
      }
      // Re-fire the catalog transform so the fresh closure map commits. No
      // surface means poll-only mode: clocks and snapshots still advance.
      if (catalogRegistration !== undefined && catalogSurface !== undefined) {
        try {
          await catalogSurface.reload();
        } catch {
          safeFailure("catalog-reload", "runtime");
        }
      }
      // Snapshot to disk once per cycle that actually polled providers: a
      // merged snapshot of ALL configured providers, so TTL-skipped ones
      // keep their clocks on disk. Failures keep their previous
      // lastSuccessMs (success-only clock); only polled providers adopt the
      // cycle trigger, the rest preserve theirs. Force cycles (rescan
      // command) stamp lastRescanAt, preserved across non-force writes. A
      // disk error must never fail the refresh.
      if (due.length > 0) {
        try {
          const trigger: StateTrigger =
            mode === "force" || mode === "merge" ? "command" : mode === "watch" ? "watch" : "poll";
          if (mode === "force") lastRescanAtMs = Date.now();
          const polledIds = new Set(due.map((target) => target.id));
          const entries = new Map<string, ProviderStateInput>();
          // Snapshot config targets plus native/rehydrated providers living
          // in `discovered` (they have no config target to iterate).
          const stateTargets: Array<{ id: string; cacheForSeconds?: number }> = [...targets];
          for (const providerID of discovered.keys()) {
            if (!stateTargets.some((target) => target.id === providerID)) {
              stateTargets.push({ id: providerID });
            }
          }
          for (const target of stateTargets) {
            const successMs = lastSuccessMs.get(target.id);
            const polledMs = lastPolledMs.get(target.id);
            if (successMs === undefined && polledMs === undefined) continue;
            const entryTrigger = polledIds.has(target.id)
              ? trigger
              : (lastTriggers.get(target.id) ?? trigger);
            let entry: ProviderStateInput = {
              lastSuccessMs: successMs,
              lastPolledMs: polledMs,
              modelCount: lastModelCounts.get(target.id) ?? 0,
              cacheForSeconds: target.cacheForSeconds ?? globalCacheForSeconds ?? null,
              lastTrigger: entryTrigger,
              // Persist the payloads too: the catalog is process-local, so a
              // restart inside the TTL rehydrates from here instead of polling.
              models: discovered.get(target.id),
            };
            const lastError = lastErrorByProvider.get(target.id);
            if (lastError !== undefined) entry.lastError = lastError;
            // mergedModelIds rides every write (not only merge cycles) so a
            // normal cycle never erases the recorded ids.
            const mergedIds = mergedModelIds.get(target.id);
            if (mergedIds !== undefined) entry = withMergedModelIds(entry, [...mergedIds]);
            entries.set(target.id, entry);
            lastTriggers.set(target.id, entryTrigger);
          }
          if (entries.size > 0) {
            writeStateFile(statePath, buildStateFile(entries, lastRescanAtMs));
          }
        } catch {
          safeFailure("state-file-write", "runtime");
        }
      }
      return buildRefreshSummary(due, results, {
        failures: [...cycleFailures].map(([providerID, failure]) => ({ providerID, ...failure })),
        withModels,
        skipped,
      });
    } catch {
      safeFailure("refresh", "runtime");
      return { outcome: "error", polled: 0, discoveredCounts: [], failed: [] };
    }
  };

  const scheduleRefresh = (
    mode: RefreshMode = "normal",
    providerFilter?: ReadonlySet<string>,
    extraTargets?: readonly ProviderTarget[],
  ): Promise<RefreshSummary | undefined> => {
    const generation = ++latestGeneration;
    refreshQueue = refreshQueue.then(() => refreshGeneration(generation, mode, providerFilter, extraTargets));
    return refreshQueue;
  };

  /**
   * Immediate refresh bypassing interval and cache TTL; the guard dedupes
   * races. Returns the cycle's summary, or undefined when superseded.
   */
  const forceRefresh = (): Promise<RefreshSummary | undefined> => scheduleRefresh("force");

  /** Merge cycle: force poll (interval+TTL+parameters bypass) with gap-fill semantics. */
  const mergeRefresh = (
    providerFilter?: ReadonlySet<string>,
    extraTargets?: readonly ProviderTarget[],
  ): Promise<RefreshSummary | undefined> => scheduleRefresh("merge", providerFilter, extraTargets);

  /** Immediate refresh that still respects each target's cache TTL. */
  const watchRefresh = (): void => {
    // A config edit may have fixed the credential a provider was paused for;
    // drop every auth pause so the edited config takes effect immediately.
    authBlockedUntil.clear();
    void scheduleRefresh("watch");
  };

  // Initial poll, then rebuild the catalog so the transform runs with data.
  // Blocking boot (background: false) awaits that first cycle here. Background
  // boot (the default) must NOT: the host gates plugin activation on setup
  // resolving, so an awaited cycle kept `/api/model` at 503 for the poll's
  // whole network time. The deferred kickoff arms the transform body (kept
  // quiet through the host's boot-time rebuilds) and runs the first cycle
  // after the host has finished booting. Warm boots inside the cacheFor TTL
  // rehydrate the catalog from the state file and skip the network entirely.
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  if (backgroundBoot) {
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      applying = true;
      void scheduleRefresh();
    }, backgroundDeferMs);
  } else {
    await scheduleRefresh();
  }

  // One ticker loop; each tick wakes only when some target's interval elapsed.
  // Periodic refreshes stay serialized; a newer generation invalidates any
  // slow poll before its results can mutate targets, ownership, or catalog.
  const tick = (): void => {
    // Trigger file = scriptable force refresh (no slash-command dispatch in
    // headless `opencode run`). Consumed once per appearance; a force cycle
    // also clears auth pauses so a rotated key is retried immediately.
    if (consumeTriggerFile(triggerPath)) {
      void scheduleRefresh("force");
      return;
    }
    if (
      computeDueTargets(
        targets,
        lastPolledMs,
        Date.now(),
        globalIntervalSeconds,
        lastSuccessMs,
        globalCacheForSeconds,
        false,
        authBlockedUntil,
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
    const bootCmdT0 = Date.now();
    try {
      commandRegistration = await commandApi.transform((draft) => {
        draft.add({
          name: "models-discovery-rescan",
          description: "Rescan discovered models now",
          execute: async (context): Promise<void> => {
            const sessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined;
            const sessionApi = ctx.session;
            // Best-effort inbox-only session ack (resume:false posts no
            // scheduled run): never fail the rescan over a missing session
            // surface or a rejected synthetic post.
            const ack = (text: string): void => {
              if (sessionID === undefined) return;
              try {
                const posted = sessionApi?.synthetic?.({
                  sessionID,
                  text: `${text} [${new Date().toISOString()}]`,
                  description: "models-discovery-rescan",
                  resume: false,
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
        draft.add({
          name: "models-discovery-merge",
          description: "Fill missing model metadata (capabilities/limit/variants) now",
          execute: async (context): Promise<void> => {
            const sessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined;
            const sessionApi = ctx.session;
            // Best-effort session ack, rescan pattern: never fail the merge
            // over a missing session surface or a rejected synthetic post.
            const ack = (text: string): void =>
              postSyntheticAck(sessionApi, sessionID, "models-discovery-merge", text);
            // Q1 (live, v2.0.17): prompt.text is exactly the argument, no
            // command prefix. Empty/whitespace = all config targets.
            const arg = typeof context?.prompt?.text === "string" ? context.prompt.text.trim() : "";
            const runMerge = async (
              label: string,
              providerFilter: ReadonlySet<string> | undefined,
              extraTargets?: readonly ProviderTarget[],
            ): Promise<void> => {
              toggleOnlyProviders.clear();
              ack(`Models-discovery merge started for ${label}.`);
              const summary = await mergeRefresh(providerFilter, extraTargets);
              if (summary === undefined) {
                ack("Models-discovery merge superseded by a newer refresh.");
                return;
              }
              ack(formatMergeAck(summary));
              for (const providerID of toggleOnlyProviders) {
                ack(
                  `Provider "${providerID}" exposes no effort levels (thinking toggle only); efforts on other providers are gateway-side mappings.`,
                );
              }
            };
            const targetIds = new Set(targets.map((target) => target.id));
            if (arg !== "" && !targetIds.has(arg)) {
              if (!catalogProviderInfo.has(arg)) {
                const nativeIds = [...catalogProviderInfo.keys()].filter((id) => !targetIds.has(id));
                ack(
                  `Models-discovery merge: unknown provider "${arg}" (not a discovery target). ` +
                    `Config targets: ${[...targetIds].join(", ") || "(none)"}. ` +
                    `Native providers: ${nativeIds.join(", ") || "(none)"}.`,
                );
                return;
              }
              // Native provider (models.dev rows, no config entry): synthesize
              // the merge target from the cached models.dev registry.
              const registry = await loadModelsDevProviders();
              registrySnapshot = registry;
              const nativeTarget = buildNativeMergeTarget(arg, catalogProviderInfo.get(arg), registry);
              if (nativeTarget === undefined) {
                ack(`Models-discovery merge: no models.dev api base for provider "${arg}"; no merge run.`);
                return;
              }
              await runMerge(`native provider "${arg}"`, new Set([arg]), [nativeTarget]);
              return;
            }
            if (arg === "") {
              await runMergeNoArg({
                sessionApi,
                sessionID,
                targetIds,
                catalogProviderInfo,
                configTargetCount: targets.length,
                runMerge,
                setRegistry: (registry): void => {
                  registrySnapshot = registry;
                },
              });
              return;
            }
            registrySnapshot = await loadModelsDevProviders();
            await runMerge(`provider "${arg}"`, new Set([arg]));
            return;
          },
        });
      });
    } catch {
      // Silent fail: the rescan command is a convenience, not a requirement.
    }
    bootCmdMs = Date.now() - bootCmdT0;
  }

  // Boot diagnostics: which awaited phase holds plugin activation open.
  console.log(
    `${LOG_PREFIX} setup ms: catalog=${bootCatMs} command=${bootCmdMs} total=${Date.now() - bootT0}`,
  );

  let cleanedUp = false;
  return async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pollInterval);
    if (bootTimer !== undefined) {
      clearTimeout(bootTimer);
      bootTimer = undefined;
    }
    configWatch.dispose();
    if (immediateRefreshHook === forceRefresh) immediateRefreshHook = undefined;
    if (catalogRegistration !== undefined) {
      try {
        await catalogRegistration.dispose();
      } catch {
        safeFailure("catalog-transform-disposal", "runtime");
      }
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
