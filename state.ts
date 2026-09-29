// Discovery state file: a disk snapshot of poll clocks/counts for `cat`-able
// observability, plus the last discovered model payloads so a restart inside a
// provider's cache TTL can repopulate the catalog without polling. The catalog
// is process-local (verified on opencode v2.0.3: no model/catalog table on disk,
// kv holds only the models.dev registry), so clocks alone cannot survive a
// restart — the models must. In-memory maps stay the source of truth; this file
// seeds clocks + models at startup and records successful cycles. Never
// credentials.
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { homedir } from "node:os";
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { dirname, join, resolve } from "node:path";
import { isRecord, LOG_PREFIX } from "./core.ts";
import { parseModelMetadata } from "./metadata.ts";
import type { ModelEntry } from "./metadata.ts";

export const STATE_FILE_ENV = "OPENCODE_MODELS_DISCOVERY_STATE_FILE";

export const STATE_FILE_VERSION = 2;

export const STATE_TRIGGERS = ["poll", "watch", "command"] as const;
export type StateTrigger = (typeof STATE_TRIGGERS)[number];

export interface ProviderStateEntry {
  lastSuccessAt: string; // ISO
  lastPolledAt: string; // ISO
  modelCount: number;
  cacheForSeconds: number | null;
  lastTrigger: StateTrigger;
  /** Last discovered payloads; absent/empty means nothing to rehydrate. */
  models?: ModelEntry[];
  /** Catalog row ids whose metadata this plugin merged; re-applied on restart. */
  mergedModelIds?: string[];
}

export interface DiscoveryStateFile {
  version: 2;
  providers: Record<string, ProviderStateEntry>;
  lastRescanAt?: string;
}

export interface ProviderStateInput {
  lastSuccessMs?: number;
  lastPolledMs?: number;
  modelCount: number;
  cacheForSeconds: number | null;
  lastTrigger: StateTrigger;
  models?: readonly ModelEntry[];
  mergedModelIds?: readonly string[];
}

function warnIgnored(reason: string): void {
  console.warn(`${LOG_PREFIX} state-file ignored (${reason}); continuing without persistence.`);
}

export function resolveStateFilePath(env: Record<string, string | undefined> = process.env): string {
  const override = env[STATE_FILE_ENV];
  if (override !== undefined && override.trim() !== "") return resolve(override.trim());
  const xdgState = env.XDG_STATE_HOME;
  const stateRoot =
    xdgState !== undefined && xdgState.trim() !== "" ? xdgState.trim() : join(homedir(), ".local", "state");
  return join(stateRoot, "opencode", "model-discovery", "state.json");
}

/**
 * Validate persisted model payloads before they can reach the catalog: ids must
 * be non-empty strings, names optional, and metadata must survive the same
 * parser the live path uses, so a hand-edited or truncated file can never inject
 * an invalid capabilities/limit/variants shape.
 */
function parseModels(value: unknown): ModelEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: ModelEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.trim() === "") continue;
    const name = typeof item.name === "string" && item.name !== "" ? item.name : undefined;
    const metadata = parseModelMetadata(item.metadata);
    parsed.push({
      id: item.id,
      ...(name !== undefined ? { name } : {}),
      ...(item.enrich === true ? { enrich: true as const } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/** Tolerant parse of the merged-model id list: absent or malformed reads as none. */
function parseMergedModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  return ids.length > 0 ? ids : undefined;
}

function parseEntry(value: unknown): ProviderStateEntry | null {
  if (!isRecord(value)) return null;
  const { lastSuccessAt, lastPolledAt, modelCount, cacheForSeconds, lastTrigger } = value;
  if (typeof lastSuccessAt !== "string" || !Number.isFinite(Date.parse(lastSuccessAt))) return null;
  if (typeof lastPolledAt !== "string" || !Number.isFinite(Date.parse(lastPolledAt))) return null;
  if (typeof modelCount !== "number" || !Number.isInteger(modelCount) || modelCount < 0) return null;
  if (!(cacheForSeconds === null || (typeof cacheForSeconds === "number" && cacheForSeconds > 0))) return null;
  if (!STATE_TRIGGERS.includes(lastTrigger as StateTrigger)) return null;
  const models = parseModels(value.models);
  const mergedModelIds = parseMergedModelIds(value.mergedModelIds);
  return {
    lastSuccessAt,
    lastPolledAt,
    modelCount,
    cacheForSeconds,
    lastTrigger: lastTrigger as StateTrigger,
    ...(models !== undefined ? { models } : {}),
    ...(mergedModelIds !== undefined ? { mergedModelIds } : {}),
  };
}

export function loadStateFile(path: string): DiscoveryStateFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // ENOENT or unreadable: no state, cold start.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnIgnored("unreadable");
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_FILE_VERSION || !isRecord(parsed.providers)) {
    warnIgnored("unsupported-shape");
    return null;
  }
  const providers: Record<string, ProviderStateEntry> = {};
  for (const [id, entry] of Object.entries(parsed.providers)) {
    const parsedEntry = parseEntry(entry);
    if (parsedEntry !== null) providers[id] = parsedEntry;
  }
  const lastRescanAt =
    typeof parsed.lastRescanAt === "string" && Number.isFinite(Date.parse(parsed.lastRescanAt))
      ? parsed.lastRescanAt
      : undefined;
  return {
    version: STATE_FILE_VERSION,
    providers,
    ...(lastRescanAt !== undefined ? { lastRescanAt } : {}),
  };
}

export function buildStateFile(
  inputs: ReadonlyMap<string, ProviderStateInput>,
  lastRescanAtMs?: number,
): DiscoveryStateFile {
  const providers: Record<string, ProviderStateEntry> = {};
  for (const [id, input] of inputs) {
    const models = input.models;
    providers[id] = {
      lastSuccessAt: new Date(input.lastSuccessMs ?? 0).toISOString(), // epoch = never succeeded
      lastPolledAt: new Date(input.lastPolledMs ?? 0).toISOString(),
      modelCount: input.modelCount,
      cacheForSeconds: input.cacheForSeconds,
      lastTrigger: input.lastTrigger,
      ...(models !== undefined && models.length > 0 ? { models: [...models] } : {}),
      ...(input.mergedModelIds !== undefined && input.mergedModelIds.length > 0
        ? { mergedModelIds: [...input.mergedModelIds] }
        : {}),
    };
  }
  const state: DiscoveryStateFile = { version: STATE_FILE_VERSION, providers };
  if (lastRescanAtMs !== undefined) state.lastRescanAt = new Date(lastRescanAtMs).toISOString();
  return state;
}

export function writeStateFile(path: string, state: DiscoveryStateFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, path);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; never surface raw errors.
    }
  }
}

/** Merged-model ids recorded for a provider; absent or malformed reads as empty. */
export function mergedModelIdsFor(state: DiscoveryStateFile, providerID: string): string[] {
  const ids = state.providers[providerID]?.mergedModelIds;
  return Array.isArray(ids) ? [...ids] : [];
}

/** Pure setter: attach merged-model ids to a provider input for the next state write. */
export function withMergedModelIds(
  input: ProviderStateInput,
  modelIDs: readonly string[],
): ProviderStateInput {
  const next: ProviderStateInput = { ...input };
  if (modelIDs.length > 0) next.mergedModelIds = [...modelIDs];
  else delete next.mergedModelIds;
  return next;
}
