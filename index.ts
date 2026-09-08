/** OpenCode plugin entrypoint; runtime wiring and pure policy live in split modules. */
/// <reference path="./types.ts" />

import { setup } from "./runtime.ts";

export default {
  id: "opencode-v2-model-discovery",
  setup,
} satisfies PluginDefinitionLite;

export {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_CACHE_FOR_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  MIN_POLL_TIMEOUT_SECONDS,
  POLL_TIMEOUT_MS,
  TICK_MS,
  resetWarnedAuthEnvIds,
  resetWarnedCacheForKeys,
  resetWarnedIntervalKeys,
  resetWarnedPollTimeoutKeys,
  resetWarnedWatchPaths,
} from "./core.ts";
export {
  parseCacheForSeconds,
  parseIntervalSeconds,
  parsePollTimeoutSeconds,
  resolveCacheForSeconds,
  resolveIntervalSeconds,
  resolvePollTimeoutSeconds,
} from "./seconds.ts";
export {
  mergeProviderConfigs,
  parseJsonc,
  parseProviders,
  resolveConfigPaths,
  resolveConfigSources,
  selectAutoTargets,
} from "./config.ts";
export {
  buildCatalogJoin,
  discoveredModelName,
  entryMatches,
  extractEntries,
  isBuiltinProviderRecord,
  mergeTargets,
  parseModelMetadata,
  reconcileOwnedModelIds,
  resolveModelMetadata,
  retainLastGood,
} from "./metadata.ts";
export {
  applyDiscovered,
  buildRefreshSummary,
  computeDueTargets,
  createConfigWatch,
  createStoreAuthResolver,
  formatRescanAck,
  pollProvider,
  requestImmediateRefresh,
  resetWarnedParametersKeys,
  resolveIntegrationCredential,
  setImmediateRefreshHook,
  setup,
} from "./runtime.ts";
export type { AutoTargetMessage } from "./core.ts";
export type {
  AutoTargetSelection,
  ConfigPathOptions,
  ConfigSource,
  EnvironmentValues,
  ParseProvidersResult,
  ProviderConfigMap,
  ProviderTarget,
} from "./config.ts";
export type {
  CatalogJoinCandidate,
  EnrichmentProvenance,
  ModelEnrichmentResolution,
  ModelEntry,
  ModelMetadata,
} from "./metadata.ts";
export type {
  ConfigWatchHandle,
  RefreshSummary,
  ResolvedStoreCredential,
  StoreAuthResolver,
} from "./runtime.ts";
