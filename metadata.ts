/** Pure metadata policy: response parsing, enrichment, catalog join, state helpers. */

import { isRecord } from "./core.ts";
import type { ProviderTarget } from "./config.ts";

export interface ModelCapabilitiesLite {
  tools: boolean;
  input: string[];
  output: string[];
}

export interface ModelLimitLite {
  context: number;
  input?: number;
  output: number;
}

export interface ModelVariantLite {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface CatalogProviderRecordLite {
  provider: {
    id: string;
    integrationID?: string;
  };
  models: ReadonlyMap<string, Record<string, unknown>>;
}

export interface ModelMetadata {
  capabilities?: ModelCapabilitiesLite;
  limit?: ModelLimitLite;
  variants?: ModelVariantLite[];
}

export interface ModelEntry {
  readonly id: string;
  readonly name?: string;
  /** Internal gate retained through polling so name-only targets never join. */
  readonly enrich?: true;
  readonly metadata?: ModelMetadata;
}

export type EnrichmentProvenance = "provider-rich" | "join" | "mixed" | "name-only";

export interface ModelEnrichmentResolution {
  readonly metadata?: ModelMetadata;
  readonly provenance: EnrichmentProvenance;
}

export interface CatalogJoinCandidate {
  readonly providerID: string;
  readonly modelID: string;
  readonly provider: CatalogProviderRecordLite["provider"];
  readonly model: Record<string, unknown>;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const values = value.map((entry) => entry.trim());
  return values.length > 0 && values.every((entry) => entry.length > 0) ? values : undefined;
}

/** Parse a comma-separated string into trimmed non-empty values (CSV-style). */
function parseCsvString(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCapabilities(value: unknown): ModelCapabilitiesLite | undefined {
  if (!isRecord(value) || typeof value.tools !== "boolean") return undefined;
  const input = parseStringArray(value.input);
  const output = parseStringArray(value.output);
  if (!input || !output) return undefined;
  return { tools: value.tools, input, output };
}

function parseLimit(value: unknown): ModelLimitLite | undefined {
  if (!isRecord(value)) return undefined;
  const context = parseNonNegativeInteger(value.context);
  const output = parseNonNegativeInteger(value.output);
  if (context === undefined || output === undefined) return undefined;
  if (value.input !== undefined && parseNonNegativeInteger(value.input) === undefined) {
    return undefined;
  }
  const input = parseNonNegativeInteger(value.input);
  return input === undefined ? { context, output } : { context, input, output };
}

/**
 * Parse a parameters-endpoint limit: `max_tokens` → context, `max_input_tokens`
 * → input, `max_output_tokens` → output. Context and output are required; input
 * is optional — the same validity rules as parseLimit.
 */
export function parseParametersLimit(record: Record<string, unknown>): ModelLimitLite | undefined {
  const context = parseNonNegativeInteger(record.max_tokens);
  const output = parseNonNegativeInteger(record.max_output_tokens);
  if (context === undefined || output === undefined) return undefined;
  const input = parseNonNegativeInteger(record.max_input_tokens);
  return input === undefined ? { context, output } : { context, input, output };
}

/**
 * Parse a parameters-endpoint capabilities shape: `supported_modalities` → input
 * modalities, `supports_function_calling` → tools. Output modalities reuse the
 * input list when the response does not supply its own (bifrost exposes only
 * `supported_modalities`).
 */
export function parseParametersCapabilities(
  record: Record<string, unknown>,
): ModelCapabilitiesLite | undefined {
  const input = parseStringArray(record.supported_modalities);
  if (!input) return undefined;
  const output = parseStringArray(record.supported_output_modalities) ?? input;
  const tools =
    typeof record.supports_function_calling === "boolean" ? record.supports_function_calling : false;
  return { tools, input, output };
}

function parseVariant(value: unknown): ModelVariantLite | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    return undefined;
  }
  const variant: ModelVariantLite = { id: value.id.trim() };
  for (const key of ["settings", "headers", "body"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (!isRecord(field)) return undefined;
    if (key === "headers" && Object.values(field).some((entry) => typeof entry !== "string")) {
      return undefined;
    }
    if (key === "settings") variant.settings = { ...field };
    if (key === "headers") variant.headers = { ...field } as Record<string, string>;
    if (key === "body") variant.body = { ...field };
  }
  return variant;
}

function parseVariants(value: unknown): ModelVariantLite[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value.map(parseVariant).filter((variant): variant is ModelVariantLite => variant !== undefined);
  return variants.length > 0 ? variants : undefined;
}

export function effortVariants(efforts: unknown): ModelVariantLite[] | undefined {
  const values = parseStringArray(efforts);
  if (!values) return undefined;
  return values.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }));
}

/** Pull an efforts field off a record and convert it to variants. */
function parseEffortField(record: unknown, key: string): ModelVariantLite[] | undefined {
  return isRecord(record) ? effortVariants(record[key]) : undefined;
}

function parseSupportedEffortVariants(value: unknown): ModelVariantLite[] | undefined {
  return parseEffortField(value, "supported_efforts");
}

/** Convert an additional_attributes.reasoning_efforts CSV list into effort variants. */
function parseAdditionalAttributesVariants(value: unknown): ModelVariantLite[] | undefined {
  if (!isRecord(value)) return undefined;
  return effortVariants(parseCsvString(value.reasoning_efforts));
}

function parseReasoningOptionVariants(value: unknown): ModelVariantLite[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants: ModelVariantLite[] = [];
  for (const option of value) {
    if (!isRecord(option) || option.type !== "effort") continue;
    const parsed = effortVariants(option.values);
    if (parsed) variants.push(...parsed);
  }
  return variants.length > 0 ? variants : undefined;
}

export function mergeVariants(
  ...lists: readonly (readonly ModelVariantLite[] | undefined)[]
): ModelVariantLite[] | undefined {
  const variants: ModelVariantLite[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const variant of list ?? []) {
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      variants.push(variant);
    }
  }
  return variants.length > 0 ? variants : undefined;
}

/**
 * Cross-provider effort join for merge cycles: effort variants for a model
 * id as OTHER providers define it in the models.dev registry
 * (reasoning_options type "effort"). Pure — the caller supplies the registry
 * snapshot; the first non-empty effort list wins.
 */
export function registryJoinVariants(
  selfProviderID: string,
  modelID: string,
  registry: ReadonlyMap<string, { models?: Readonly<Record<string, unknown>> }>,
): ModelVariantLite[] | undefined {
  for (const [providerID, entry] of registry) {
    if (providerID === selfProviderID) continue;
    const model = entry.models?.[modelID];
    if (!isRecord(model)) continue;
    const variants = parseReasoningOptionVariants(model.reasoning_options);
    if (variants !== undefined) return variants;
  }
  return undefined;
}

function composeMetadata(
  capabilities: ModelCapabilitiesLite | undefined,
  limit: ModelLimitLite | undefined,
  variants: ModelVariantLite[] | undefined,
): ModelMetadata | undefined {
  if (!capabilities && !limit && !variants) return undefined;
  const metadata: ModelMetadata = {};
  if (capabilities) metadata.capabilities = capabilities;
  if (limit) metadata.limit = limit;
  if (variants) metadata.variants = variants;
  return metadata;
}

function normalizeMetadata(value: Record<string, unknown>): ModelMetadata | undefined {
  return composeMetadata(
    parseCapabilities(value.capabilities),
    parseLimit(value.limit),
    mergeVariants(parseVariants(value.variants), parseReasoningOptionVariants(value.reasoning_options)),
  );
}

function parseModalityString(value: string): { input: string[]; output: string[] } | undefined {
  const parts = value.split("->");
  if (parts.length !== 2) return undefined;
  const input = parseStringArray(parts[0]?.split("+"));
  const output = parseStringArray(parts[1]?.split("+"));
  return input && output ? { input, output } : undefined;
}

function hasToolsFeature(value: unknown): boolean {
  return parseStringArray(value)?.includes("tools") === true;
}

function parseModalitiesCapabilities(record: Record<string, unknown>): ModelCapabilitiesLite | undefined {
  const sources: unknown[] = [record.modalities, record.architecture, record];
  for (const source of sources) {
    if (typeof source === "string") {
      const parsed = parseModalityString(source);
      if (parsed) return { tools: false, ...parsed };
      continue;
    }
    if (!isRecord(source)) continue;
    const input = firstStringArray([source], ["input", "input_modalities"]);
    const output = firstStringArray([source], ["output", "output_modalities"]);
    if (input && output) {
      const tools =
        typeof source.tools === "boolean"
          ? source.tools
          : typeof record.tools === "boolean"
            ? record.tools
            : hasToolsFeature(source.supported_features) || hasToolsFeature(record.supported_features);
      return { tools, input, output };
    }
    if (typeof source.modality === "string") {
      const parsed = parseModalityString(source.modality);
      if (parsed) return { tools: false, ...parsed };
    }
  }
  return undefined;
}

function firstInteger(
  sources: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = parseNonNegativeInteger(source?.[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstStringArray(
  sources: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string[] | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = parseStringArray(source?.[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function parseOpenRouterLimit(record: Record<string, unknown>): ModelLimitLite | undefined {
  const topProvider = isRecord(record.top_provider) ? record.top_provider : undefined;
  const architecture = isRecord(record.architecture) ? record.architecture : undefined;
  const sources = [record, topProvider, architecture];
  const context = firstInteger(sources, ["context_length", "max_context_length"]);
  const output = firstInteger(sources, ["max_output_tokens", "max_completion_tokens"]);
  if (context === undefined || output === undefined) return undefined;
  const input = firstInteger(sources, ["max_input_tokens"]);
  return input === undefined ? { context, output } : { context, input, output };
}

/** Parse provider metadata only when the explicit enrichment gate is active. */
export function parseModelMetadata(value: unknown): ModelMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const normalized = normalizeMetadata(value);
  return composeMetadata(
    normalized?.capabilities ?? parseModalitiesCapabilities(value),
    normalized?.limit ?? parseOpenRouterLimit(value),
    mergeVariants(
      normalized?.variants,
      parseSupportedEffortVariants(value.reasoning),
      parseAdditionalAttributesVariants(value.additional_attributes),
    ),
  );
}

/** Extract model entries from a /models response body. Undefined = unrecognized shape. */
export function extractEntries(body: unknown, enrich = false): ModelEntry[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined;
  if (!list) return undefined;

  const entries: ModelEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const metadata = enrich ? parseModelMetadata(item) : undefined;
    entries.push({
      id,
      name: typeof item.name === "string" && item.name.length > 0 ? item.name : undefined,
      ...(metadata ? { metadata } : {}),
    });
  }
  return entries;
}

function candidateModelIDs(candidate: CatalogJoinCandidate): string[] {
  const model = candidate.model as unknown as Record<string, unknown>;
  return [candidate.modelID, model.id, model.modelID].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isModelIDSuffix(left: string, right: string): boolean {
  return left !== right && (left.endsWith(`/${right}`) || right.endsWith(`/${left}`));
}

function chooseJoinCandidate(
  candidates: readonly CatalogJoinCandidate[],
  isBuiltin: (candidate: CatalogJoinCandidate) => boolean,
): CatalogJoinCandidate | undefined {
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return unique[0];
  const builtins = unique.filter(isBuiltin);
  return builtins.length === 1 ? builtins[0] : undefined;
}

/** Conservative predicate for records supplied by the runtime builtin catalog. */
export function isBuiltinProviderRecord(
  provider: CatalogJoinCandidate["provider"],
): boolean {
  return typeof provider.integrationID === "string" && provider.integrationID.length > 0;
}

export function buildCatalogJoin(
  records: readonly CatalogProviderRecordLite[],
): CatalogJoinCandidate[] {
  const candidates: CatalogJoinCandidate[] = [];
  for (const record of records) {
    if (!record?.provider || typeof record.provider.id !== "string") continue;
    try {
      for (const [modelID, model] of record.models) {
        if (typeof modelID !== "string" || !model) continue;
        candidates.push({
          providerID: record.provider.id,
          modelID,
          provider: record.provider,
          model,
        });
      }
    } catch {
      // A malformed provider record contributes no join candidates.
    }
  }
  return candidates;
}

function chooseCatalogCandidate(
  providerID: string,
  modelID: string,
  candidates: readonly CatalogJoinCandidate[],
  isBuiltin: (candidate: CatalogJoinCandidate) => boolean,
): CatalogJoinCandidate | undefined {
  const otherProviders = candidates.filter((candidate) => candidate.providerID !== providerID);
  const exact = otherProviders.filter((candidate) => candidateModelIDs(candidate).includes(modelID));
  if (exact.length > 0) return chooseJoinCandidate(exact, isBuiltin);
  const suffix = otherProviders.filter((candidate) =>
    candidateModelIDs(candidate).some((candidateID) => isModelIDSuffix(modelID, candidateID)),
  );
  return chooseJoinCandidate(suffix, isBuiltin);
}

/** Resolve rich metadata per FIELD: the provider response wins a field it
 * supplies; the catalog join fills the rest; provenance reports the sources. */
export function resolveModelMetadata(
  providerID: string,
  modelID: string,
  providerRich: ModelMetadata | undefined,
  candidates: readonly CatalogJoinCandidate[],
  isBuiltin: (candidate: CatalogJoinCandidate) => boolean = (candidate) =>
    isBuiltinProviderRecord(candidate.provider),
): ModelEnrichmentResolution {
  const rich = providerRich
    ? normalizeMetadata(providerRich as unknown as Record<string, unknown>)
    : undefined;
  const candidate = chooseCatalogCandidate(providerID, modelID, candidates, isBuiltin);
  const joined = candidate
    ? normalizeMetadata(candidate.model as unknown as Record<string, unknown>)
    : undefined;

  let richUsed = false;
  let joinUsed = false;
  const pick = <T>(richValue: T | undefined, joinValue: T | undefined): T | undefined => {
    if (richValue !== undefined) {
      richUsed = true;
      return richValue;
    }
    if (joinValue !== undefined) {
      joinUsed = true;
      return joinValue;
    }
    return undefined;
  };
  const capabilities = pick(rich?.capabilities, joined?.capabilities);
  const limit = pick(rich?.limit, joined?.limit);
  const variants = pick(rich?.variants, joined?.variants);

  const metadata = composeMetadata(capabilities, limit, variants);
  if (!metadata) return { provenance: "name-only" };
  const provenance: EnrichmentProvenance =
    richUsed && joinUsed ? "mixed" : richUsed ? "provider-rich" : "join";
  return { metadata, provenance };
}

/**
 * Gap-fill writer for catalog rows: assigns a resolved metadata field ONLY
 * when the row lacks it; an existing field is never overwritten. Name stays
 * with discoveredModelName. Pure — no I/O, no logging.
 * A field counts as lacking when absent OR empty (the live catalog materializes empty objects/arrays before transforms run).
 */
export function applyMetadataGapFill(
  row: {
    capabilities?: ModelCapabilitiesLite;
    limit?: ModelLimitLite;
    variants?: ModelVariantLite[];
  },
  resolution: ModelEnrichmentResolution | undefined,
): number {
  const metadata = resolution?.metadata;
  if (!metadata) return 0;
  let filled = 0;
  if (
    (row.capabilities === undefined || Object.keys(row.capabilities).length === 0) &&
    metadata.capabilities !== undefined
  ) {
    row.capabilities = metadata.capabilities;
    filled += 1;
  }
  if (
    (row.limit === undefined || Object.keys(row.limit).length === 0) &&
    metadata.limit !== undefined
  ) {
    row.limit = metadata.limit;
    filled += 1;
  }
  if (
    (row.variants === undefined || row.variants.length === 0) &&
    metadata.variants !== undefined
  ) {
    row.variants = metadata.variants;
    filled += 1;
  }
  return filled;
}

export function entryMatches(entry: ModelEntry, filter: string | undefined): boolean {
  return !filter || entry.id.includes(filter);
}

/** Preserve a non-empty catalog name unless it is already the model id. */
export function discoveredModelName(
  existingName: unknown,
  modelID: string,
  discoveredName: string | undefined,
): string {
  if (typeof existingName === "string" && existingName.length > 0 && existingName !== modelID) {
    return existingName;
  }
  return discoveredName ?? modelID;
}

/** Merge manual and auto targets. Manual targets win when ids collide. */
export function mergeTargets(
  manual: readonly ProviderTarget[],
  auto: readonly ProviderTarget[],
): ProviderTarget[] {
  const byId = new Map<string, ProviderTarget>();
  for (const target of auto) byId.set(target.id, target);
  for (const target of manual) byId.set(target.id, target);
  return [...byId.values()];
}

/** Keep the previous provider list when a poll fails; replace it on success. */
export function retainLastGood(
  discovered: ReadonlyMap<string, ModelEntry[]>,
  providerID: string,
  next: readonly ModelEntry[] | undefined,
): Map<string, ModelEntry[]> {
  const retained = new Map(discovered);
  if (next !== undefined) retained.set(providerID, [...next]);
  return retained;
}

/** Reconcile plugin-owned IDs without coupling ownership to rich model metadata. */
export function reconcileOwnedModelIds(
  previousOwned: ReadonlySet<string>,
  models: readonly ModelEntry[],
): { retained: Set<string>; removed: Set<string> } {
  const nextModelIds = new Set(models.map((model) => model.id));
  return {
    retained: new Set([...previousOwned].filter((modelID) => nextModelIds.has(modelID))),
    removed: new Set([...previousOwned].filter((modelID) => !nextModelIds.has(modelID))),
  };
}
