/**
 * Experiential Labs catalog enrichment tests: fixtures, classification,
 * bounds, TTL/backoff/dedupe, and the explicit-deny marker's join suppression.
 *
 * Fixtures objA/objB/objC are verbatim live catalog entries (2026-09-30); the
 * MiMo/claude-fable-5 fixtures are trimmed projections of the same live page
 * (ids, statuses, routability, and capability keys preserved exactly). No test
 * reads /tmp or touches the network: every fetch is stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyDiscovered,
  parseModelMetadata,
  pollProvider,
  resolveModelMetadata,
  setModelsDevRegistryForTests,
  setup,
} from "opencode-v2-model-discovery";
import type { CatalogJoinCandidate, ModelEntry, ProviderTarget } from "opencode-v2-model-discovery";
import {
  EXPERIENTIAL_CATALOG_TTL_ENV,
  EXPERIENTIAL_CATALOG_TTL_SECONDS,
  EXPERIENTIAL_CATALOG_URL_ENV,
  MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS,
  experientialCatalogURL,
  fetchExperientialRouteEfforts,
  parseExperientialCatalogTtlSeconds,
  resolveExperientialCatalogTtlSeconds,
} from "./experiential.ts";
import {
  STATE_FILE_ENV,
  buildStateFile,
  loadStateFile,
  withMergedModelIds,
  writeStateFile,
} from "./state.ts";

// ---------------------------------------------------------------------------
// Verbatim fixtures (injected from /tmp/opencode/explab-phase1/*_full.json)
// ---------------------------------------------------------------------------

const objA = {
 "model": {
  "id": "bb71497c-6eed-47f1-924c-17b73faa523f",
  "slug": "muse-spark-1.3-contributor",
  "display_name": "Muse Spark 1.3 Contributor",
  "description": null,
  "release_date": null,
  "context_window": 1048576,
  "max_output_tokens": 16384,
  "max_input_tokens": 1048576,
  "input_modalities": [
   "text"
  ],
  "output_modalities": [
   "text"
  ],
  "supported_params": {
   "stop": false,
   "tools": true,
   "top_p": true,
   "logprobs": false,
   "reasoning": true,
   "temperature": true,
   "response_format": true,
   "structured_outputs": true
  },
  "category": null,
  "tags": [],
  "icon": null,
  "maker": null,
  "owning_org_id": null,
  "preferred_rank": null,
  "status": "active",
  "created_at": "2026-09-05T04:51:01.777789+00:00",
  "updated_at": "2026-09-15T08:34:00.811482+00:00"
 },
 "providers": [
  {
   "id": "eda95e88-1d4b-403d-8b5a-2e7923a67b91",
   "model_id": "bb71497c-6eed-47f1-924c-17b73faa523f",
   "provider": "meta",
   "provider_model_id": "muse-spark-1.3-contributor",
   "base_url": null,
   "region": null,
   "api_version": null,
   "owning_org_id": null,
   "provider_connection_id": null,
   "connection_alias": null,
   "route_id": null,
   "billing_source": "host_managed",
   "input_nano_usd_per_million": 100000000,
   "cached_input_nano_usd_per_million": 2000000,
   "cache_write_input_nano_usd_per_million": null,
   "cache_write_1h_input_nano_usd_per_million": null,
   "long_context_cache_write_input_nano_usd_per_million": null,
   "long_context_cache_write_1h_input_nano_usd_per_million": null,
   "output_nano_usd_per_million": 200000000,
   "reasoning_nano_usd_per_million": null,
   "long_context_threshold_tokens": null,
   "long_context_input_nano_usd_per_million": null,
   "long_context_cached_input_nano_usd_per_million": null,
   "long_context_output_nano_usd_per_million": null,
   "long_context_reasoning_nano_usd_per_million": null,
   "pricing_source": "meta:list@2026-09-03",
   "pricing_effective_at": "2026-09-03T00:00:00+00:00",
   "capabilities": {
    "maximum_top_p": 1,
    "minimum_top_p": 0.01,
    "supports_top_p": true,
    "supports_logprobs": false,
    "supports_reasoning": true,
    "supports_streaming": true,
    "maximum_temperature": 2,
    "minimum_temperature": 0,
    "supports_temperature": true,
    "supports_strict_tools": true,
    "supports_stop_sequences": false,
    "reasoning_default_effort": "medium",
    "reports_reasoning_tokens": true,
    "supports_structured_text": true,
    "reasoning_effort_required": false,
    "supports_structured_output": true,
    "reports_cached_input_tokens": true,
    "supports_embeddings": false,
    "supported_reasoning_efforts": [
     "minimal",
     "low",
     "medium",
     "high",
     "xhigh"
    ]
   },
   "uptime_30d": 93.65562745844436,
   "uptime_recent": 80.73510773130545,
   "uptime_recent_requests": 789,
   "throughput_tps": 244.604316546763,
   "latency_p50_ms": 2668.0,
   "stats_source": "observed",
   "status": "active",
   "routable": true,
   "requires_payment": false,
   "requires_purchase": false,
   "hidden_fallback": false,
   "available_to_org": null,
   "zero_data_retention": null,
   "zero_data_retention_on_request": null,
   "processing_region_sets": [],
   "plan_discounts": null,
   "service_tier_rates": null,
   "endpoint_credential_last4": null,
   "created_at": "2026-09-05T04:51:01.777789+00:00",
   "updated_at": "2026-09-15T08:34:00.811482+00:00"
  }
 ],
 "default_provider_ids": [
  "eda95e88-1d4b-403d-8b5a-2e7923a67b91"
 ],
 "retention": "not_zdr",
 "promotional_listed": false
};

const objB = {
 "model": {
  "id": "3b44048b-750a-4086-8727-8d5e29245287",
  "slug": "deepseek-v4-flash-0423",
  "display_name": "DeepSeek V4 Flash 0423",
  "description": null,
  "release_date": "2026-09-11",
  "context_window": null,
  "max_output_tokens": null,
  "max_input_tokens": null,
  "input_modalities": [
   "text"
  ],
  "output_modalities": [
   "text"
  ],
  "supported_params": {
   "top_k": false,
   "top_p": false,
   "logprobs": false,
   "reasoning": false,
   "temperature": false
  },
  "category": null,
  "tags": [],
  "icon": null,
  "maker": null,
  "owning_org_id": null,
  "preferred_rank": null,
  "status": "active",
  "created_at": "2026-09-11T17:02:23.340264+00:00",
  "updated_at": "2026-09-11T17:02:23.340264+00:00"
 },
 "providers": [
  {
   "id": "6b1841f2-8ce9-4b74-b070-d98abb7c8cf6",
   "model_id": "3b44048b-750a-4086-8727-8d5e29245287",
   "provider": "wafer",
   "provider_model_id": "DeepSeek-V4-Flash-0423",
   "base_url": null,
   "region": null,
   "api_version": null,
   "owning_org_id": null,
   "provider_connection_id": null,
   "connection_alias": null,
   "route_id": null,
   "billing_source": "customer_managed",
   "input_nano_usd_per_million": null,
   "cached_input_nano_usd_per_million": null,
   "cache_write_input_nano_usd_per_million": null,
   "cache_write_1h_input_nano_usd_per_million": null,
   "long_context_cache_write_input_nano_usd_per_million": null,
   "long_context_cache_write_1h_input_nano_usd_per_million": null,
   "output_nano_usd_per_million": null,
   "reasoning_nano_usd_per_million": null,
   "long_context_threshold_tokens": null,
   "long_context_input_nano_usd_per_million": null,
   "long_context_cached_input_nano_usd_per_million": null,
   "long_context_output_nano_usd_per_million": null,
   "long_context_reasoning_nano_usd_per_million": null,
   "pricing_source": null,
   "pricing_effective_at": null,
   "capabilities": {
    "supports_tools": false,
    "supports_top_k": false,
    "supports_top_p": false,
    "supports_logprobs": false,
    "supports_reasoning": false,
    "supports_streaming": true,
    "supports_temperature": false,
    "supports_structured_output": false,
    "sampling_requires_reasoning_none": false,
    "supports_embeddings": false
   },
   "uptime_30d": null,
   "uptime_recent": null,
   "uptime_recent_requests": null,
   "throughput_tps": null,
   "latency_p50_ms": null,
   "stats_source": null,
   "status": "active",
   "routable": null,
   "requires_payment": false,
   "requires_purchase": false,
   "hidden_fallback": false,
   "available_to_org": null,
   "zero_data_retention": null,
   "zero_data_retention_on_request": null,
   "processing_region_sets": [],
   "plan_discounts": null,
   "service_tier_rates": null,
   "endpoint_credential_last4": null,
   "created_at": "2026-09-11T17:02:23.340264+00:00",
   "updated_at": "2026-09-11T17:02:23.340264+00:00"
  }
 ],
 "default_provider_ids": [
  "6b1841f2-8ce9-4b74-b070-d98abb7c8cf6"
 ],
 "retention": null,
 "promotional_listed": false
};

const objC = {
 "model": {
  "id": "dc4679da-3b2a-478e-8918-77473a8a0ebc",
  "slug": "ada",
  "display_name": "Ada",
  "description": null,
  "release_date": null,
  "context_window": null,
  "max_output_tokens": null,
  "max_input_tokens": null,
  "input_modalities": [
   "text"
  ],
  "output_modalities": [
   "text"
  ],
  "supported_params": {},
  "category": null,
  "tags": [
   "retired"
  ],
  "icon": null,
  "maker": null,
  "owning_org_id": null,
  "preferred_rank": null,
  "status": "active",
  "created_at": "2026-08-30T12:40:53.330398+00:00",
  "updated_at": "2026-09-29T13:53:17.869503+00:00"
 },
 "providers": [
  {
   "id": "d6ebad0c-ecf6-45db-bbad-641ac1e3e1e1",
   "model_id": "dc4679da-3b2a-478e-8918-77473a8a0ebc",
   "provider": "azure_openai",
   "provider_model_id": "ada",
   "base_url": null,
   "region": null,
   "api_version": null,
   "owning_org_id": null,
   "provider_connection_id": null,
   "connection_alias": null,
   "route_id": null,
   "billing_source": "customer_managed",
   "input_nano_usd_per_million": null,
   "cached_input_nano_usd_per_million": null,
   "cache_write_input_nano_usd_per_million": null,
   "cache_write_1h_input_nano_usd_per_million": null,
   "long_context_cache_write_input_nano_usd_per_million": null,
   "long_context_cache_write_1h_input_nano_usd_per_million": null,
   "output_nano_usd_per_million": null,
   "reasoning_nano_usd_per_million": null,
   "long_context_threshold_tokens": null,
   "long_context_input_nano_usd_per_million": null,
   "long_context_cached_input_nano_usd_per_million": null,
   "long_context_output_nano_usd_per_million": null,
   "long_context_reasoning_nano_usd_per_million": null,
   "pricing_source": null,
   "pricing_effective_at": null,
   "capabilities": {
    "supports_top_k": false,
    "supports_top_p": false,
    "reports_refusals": false,
    "supports_logprobs": false,
    "supports_reasoning": false,
    "supports_streaming": true,
    "supports_temperature": false,
    "chat_max_tokens_field": "max_tokens",
    "supports_stop_sequences": true,
    "reports_reasoning_tokens": false,
    "supports_structured_text": true,
    "supports_structured_output": false,
    "reports_cached_input_tokens": false,
    "supports_developer_messages": true,
    "supports_parallel_tool_calls": true,
    "sampling_requires_reasoning_none": false,
    "supports_streaming_tool_arguments": true,
    "reports_cache_creation_input_tokens": false,
    "supports_embeddings": false
   },
   "uptime_30d": null,
   "uptime_recent": null,
   "uptime_recent_requests": null,
   "throughput_tps": null,
   "latency_p50_ms": null,
   "stats_source": null,
   "status": "disabled",
   "routable": null,
   "requires_payment": false,
   "requires_purchase": false,
   "hidden_fallback": false,
   "available_to_org": null,
   "zero_data_retention": null,
   "zero_data_retention_on_request": null,
   "processing_region_sets": [],
   "plan_discounts": null,
   "service_tier_rates": null,
   "endpoint_credential_last4": null,
   "created_at": "2026-08-30T12:40:53.330398+00:00",
   "updated_at": "2026-09-29T13:55:21.91268+00:00"
  }
 ],
 "default_provider_ids": [],
 "retention": null,
 "promotional_listed": false
};

// ---------------------------------------------------------------------------
// Trimmed live projections: MiMo + claude-fable-5
// ---------------------------------------------------------------------------

/** mimo-v2.5: TWO defaults; the first carries 4 efforts, the second only ["medium"]. */
const mimoV25 = {
  model: { slug: "mimo-v2.5" },
  providers: [
    {
      id: "7b8c0cb7-f156-45c9-a7b3-b4fa0fae9f00",
      provider: "experiential_cloud",
      status: "active",
      routable: true,
      capabilities: { supports_reasoning: true, supported_reasoning_efforts: ["medium"] },
    },
    {
      id: "184d9ea8-9d56-4620-9505-5931106ce1b0",
      provider: "experiential_cloud",
      status: "active",
      routable: true,
      capabilities: {
        supports_reasoning: true,
        supported_reasoning_efforts: ["none", "low", "medium", "high"],
      },
    },
  ],
  default_provider_ids: [
    "184d9ea8-9d56-4620-9505-5931106ce1b0",
    "7b8c0cb7-f156-45c9-a7b3-b4fa0fae9f00",
  ],
};

/** mimo-v2.5-pro: first default has 7 efforts; a NON-default tencent route is routable:false. */
const mimoV25Pro = {
  model: { slug: "mimo-v2.5-pro" },
  providers: [
    {
      id: "5a9fc78b-cc41-4325-926f-3b188c789d4b",
      provider: "experiential_cloud",
      status: "active",
      routable: true,
      capabilities: { supports_reasoning: true, supported_reasoning_efforts: ["medium"] },
    },
    {
      id: "cc96795c-0f1f-4cf4-8f4e-0b7447c52472",
      provider: "tencent",
      status: "active",
      routable: false,
      capabilities: {
        supports_reasoning: true,
        supported_reasoning_efforts: ["none", "low", "medium", "high"],
      },
    },
    {
      id: "0db78474-8491-4388-aa15-f9151f14b435",
      provider: "experiential_cloud",
      status: "active",
      routable: true,
      capabilities: {
        supports_reasoning: true,
        supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
    },
  ],
  default_provider_ids: [
    "0db78474-8491-4388-aa15-f9151f14b435",
    "5a9fc78b-cc41-4325-926f-3b188c789d4b",
  ],
};

/**
 * mimo-v2.6-pro: the wally primary (4da5a354) is active+routable but publishes
 * NO capability keys → UNKNOWN (no marker, no entry). The disabled
 * experiential_cloud route advertising ["medium"] is non-default and never read.
 */
const mimoV26Pro = {
  model: { slug: "mimo-v2.6-pro" },
  providers: [
    {
      id: "0f7941c7-0e21-4cb0-b042-f5f0a5b5418c",
      provider: "experiential_cloud",
      status: "disabled",
      routable: false,
      capabilities: { supports_reasoning: true, supported_reasoning_efforts: ["medium"] },
    },
    {
      id: "4da5a354-2518-4ad5-bbe8-9194bfd4dda7",
      provider: "wally",
      status: "active",
      routable: true,
      capabilities: {},
    },
    {
      id: "e014a693-e7e0-4987-98d1-7096d37a64b1",
      provider: "fireworks",
      status: "active",
      routable: null,
      capabilities: { supports_reasoning: false },
    },
  ],
  default_provider_ids: ["4da5a354-2518-4ad5-bbe8-9194bfd4dda7"],
};

/**
 * claude-fable-5: the first default (f58593c4) is active+routable with
 * supports_reasoning:false and no effort key → explicit deny. The second
 * default advertises efforts and must never be read instead.
 */
const claudeFable5 = {
  model: { slug: "claude-fable-5" },
  providers: [
    {
      id: "f58593c4-1efb-4d85-b1b2-dfd2d24d6e85",
      provider: "experiential_cloud",
      status: "active",
      routable: true,
      capabilities: { supports_reasoning: false },
    },
    {
      id: "6f5aa700-a7c5-4277-be49-82cfa0ba37a2",
      provider: "anthropic",
      status: "active",
      routable: true,
      capabilities: {
        supports_reasoning: true,
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  ],
  default_provider_ids: [
    "f58593c4-1efb-4d85-b1b2-dfd2d24d6e85",
    "6f5aa700-a7c5-4277-be49-82cfa0ba37a2",
    "8d908205-6ac0-42d2-a365-bf57d692fb86",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPLABS_BASE = "https://api.experientiallabs.ai/v1";

/** Unique catalog URL per test case: the module cache is keyed by URL. */
let caseSeq = 0;
function caseURL(): string {
  caseSeq += 1;
  return `https://api.experientiallabs.ai/api/models?case=${caseSeq}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function catalogResponse(models: unknown[]): Response {
  return jsonResponse({ models });
}

const effortVariants = (efforts: string[]): Array<{ id: string }> =>
  efforts.map((effort) => ({ id: effort }));

interface StubCall {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
}

/** Route-based global fetch stub: /api/models is the catalog, everything else is the provider. */
function installFetch(routes: {
  models?: (url: URL, headers: Record<string, string> | undefined) => Response;
  catalog?: (
    url: URL,
    headers: Record<string, string> | undefined,
  ) => Response | Promise<Response>;
}): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (rawUrl: unknown, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: url.toString(), headers });
    if (url.pathname === "/api/models") {
      return routes.catalog ? await routes.catalog(url, headers) : catalogResponse([]);
    }
    return routes.models ? routes.models(url, headers) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const catalogCalls = (calls: readonly StubCall[]): number =>
  calls.filter((call) => new URL(call.url).pathname === "/api/models").length;

const explabsTarget = (extra: Record<string, unknown> = {}): ProviderTarget =>
  ({ id: "explabs", baseURL: EXPLABS_BASE, enrich: true, ...extra }) as ProviderTarget;

interface FixtureRoute {
  id: string;
  status?: string;
  routable?: boolean | null;
  capabilities?: Record<string, unknown>;
}

/** Synthetic catalog entry with the live page's shape. */
function catalogEntry(
  slug: string,
  routes: FixtureRoute[],
  defaults?: Array<string | undefined>,
): Record<string, unknown> {
  return {
    model: { slug },
    providers: routes.map((route) => ({
      id: route.id,
      provider: "synthetic",
      status: route.status ?? "active",
      routable: route.routable === undefined ? true : route.routable,
      capabilities: route.capabilities ?? {},
    })),
    default_provider_ids:
      defaults ??
      routes
        .map((route) => route.id)
        .filter((id): id is string => typeof id === "string")
        .slice(0, 1),
  };
}

function makeDraft(rows: Map<string, Record<string, unknown>>): any {
  return {
    model: {
      get: (providerID: string, modelID: string) => rows.get(`${providerID}:${modelID}`),
      update: (providerID: string, modelID: string, update: (model: any) => void) => {
        const key = `${providerID}:${modelID}`;
        const row = rows.get(key) ?? {};
        update(row);
        rows.set(key, row);
      },
      remove: (providerID: string, modelID: string) => {
        rows.delete(`${providerID}:${modelID}`);
      },
    },
  };
}

const ENV_KEYS = [EXPERIENTIAL_CATALOG_URL_ENV, EXPERIENTIAL_CATALOG_TTL_ENV] as const;
const previousEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
});
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// URL gate
// ---------------------------------------------------------------------------

describe("experiential catalog URL gate", () => {
  test("lookalike hosts never resolve a catalog URL or issue a catalog request", async () => {
    const lookalikes = [
      "api.experientiallabs.ai.evil.example",
      "apiexperientiallabs.ai",
      "experientiallabs.ai",
      "api.experientiallabs-ai.com",
    ];
    for (const host of lookalikes) {
      expect(experientialCatalogURL(`https://${host}/v1`)).toBeUndefined();
      const previous = globalThis.fetch;
      const finish = installFetch({ models: () => jsonResponse({ data: [{ id: "m1" }] }) });
      try {
        await pollProvider(explabsTarget({ baseURL: `https://${host}/v1` }));
        expect(catalogCalls(finish.calls)).toBe(0);
      } finally {
        finish.restore();
        globalThis.fetch = previous;
      }
    }
  });

  test("uppercase API.EXPERIENTIALLABS.AI matches and issues exactly one catalog request", async () => {
    expect(experientialCatalogURL("https://API.EXPERIENTIALLABS.AI/v1")).toBe(
      "https://api.experientiallabs.ai/api/models",
    );
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () => catalogResponse([catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }])]),
    });
    try {
      const result = await pollProvider(explabsTarget({ baseURL: "https://API.EXPERIENTIALLABS.AI/v1" }));
      expect(catalogCalls(finish.calls)).toBe(1);
      expect(result?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low"]);
    } finally {
      finish.restore();
    }
  });

  test("env seam is used only when its host[:port] matches the provider host[:port]", () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/stub/models";
    expect(experientialCatalogURL(EXPLABS_BASE)).toBe("https://api.experientiallabs.ai/stub/models");
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "http://127.0.0.1:43171/api/models";
    expect(experientialCatalogURL(EXPLABS_BASE)).toBeUndefined();
    expect(experientialCatalogURL("http://127.0.0.1:43171/v1")).toBe(
      "http://127.0.0.1:43171/api/models",
    );
    expect(experientialCatalogURL("not a url")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

describe("experiential route classification", () => {
  test("objA positive efforts, objB explicit deny, objC no entry (verbatim fixtures)", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () => catalogResponse([objA, objB, objC])) as typeof fetch,
    });
    expect(map?.get("muse-spark-1.3-contributor")).toEqual({
      denied: false,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    });
    expect(map?.get("deepseek-v4-flash-0423")).toEqual({ denied: true });
    expect(map?.has("ada")).toBe(false);
  });

  test("declared default route missing from providers is UNKNOWN (no entry)", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry("dangling", [{ id: "r1" }], ["missing-route-id"]),
          catalogEntry("no-defaults", [{ id: "r1" }], []),
        ])) as typeof fetch,
    });
    expect(map?.has("dangling")).toBe(false);
    expect(map?.has("no-defaults")).toBe(false);
  });

  test("matched route with no capability keys is UNKNOWN (no entry)", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () => catalogResponse([catalogEntry("silent", [{ id: "r1" }])])) as typeof fetch,
    });
    expect(map?.has("silent")).toBe(false);
  });

  test("supports_reasoning:false on the default route is explicit deny", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry("reasoning-off", [
            { id: "r1", capabilities: { supports_reasoning: false } },
          ]),
        ])) as typeof fetch,
    });
    expect(map?.get("reasoning-off")).toEqual({ denied: true });
  });

  test("empty supported_reasoning_efforts array is explicit deny", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry("empty-efforts", [
            { id: "r1", capabilities: { supported_reasoning_efforts: [] } },
          ]),
        ])) as typeof fetch,
    });
    expect(map?.get("empty-efforts")).toEqual({ denied: true });
  });

  test("inactive or unroutable default routes are explicit deny", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry("inactive", [
            {
              id: "r1",
              status: "disabled",
              capabilities: { supported_reasoning_efforts: ["low"] },
            },
          ]),
          catalogEntry("unroutable", [
            {
              id: "r1",
              routable: false,
              capabilities: { supported_reasoning_efforts: ["low"] },
            },
          ]),
        ])) as typeof fetch,
    });
    expect(map?.get("inactive")).toEqual({ denied: true });
    expect(map?.get("unroutable")).toEqual({ denied: true });
  });

  test("non-default routes are never read (inactive, unroutable, or effort-bearing)", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry(
            "first-default-only",
            [
              { id: "a", capabilities: { supported_reasoning_efforts: ["high"] } },
              {
                id: "b",
                status: "disabled",
                routable: false,
                capabilities: { supported_reasoning_efforts: ["none"] },
              },
              { id: "c", routable: false, capabilities: { supported_reasoning_efforts: ["low"] } },
            ],
            ["a"],
          ),
        ])) as typeof fetch,
    });
    expect(map?.get("first-default-only")).toEqual({ denied: false, efforts: ["high"] });
  });

  test("routable:null default route with efforts is positive", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () =>
        catalogResponse([
          catalogEntry("null-routable", [
            { id: "r1", routable: null, capabilities: { supported_reasoning_efforts: ["low", "high"] } },
          ]),
        ])) as typeof fetch,
    });
    expect(map?.get("null-routable")).toEqual({ denied: false, efforts: ["low", "high"] });
  });

  test("MiMo fixtures: first default only; non-default routes never read", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () => catalogResponse([mimoV25, mimoV25Pro, mimoV26Pro])) as typeof fetch,
    });
    // mimo-v2.5: the first default's 4 efforts, never the second default's ["medium"].
    expect(map?.get("mimo-v2.5")).toEqual({
      denied: false,
      efforts: ["none", "low", "medium", "high"],
    });
    // mimo-v2.5-pro: the first default's 7 efforts; the routable:false tencent route is irrelevant.
    expect(map?.get("mimo-v2.5-pro")).toEqual({
      denied: false,
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    // mimo-v2.6-pro: wally primary has no capability keys → UNKNOWN, no entry.
    expect(map?.has("mimo-v2.6-pro")).toBe(false);
  });

  test("claude-fable-5: deny class first default, second default ignored", async () => {
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, {
      fetchImpl: (async () => catalogResponse([claudeFable5])) as typeof fetch,
    });
    expect(map?.get("claude-fable-5")).toEqual({ denied: true });
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("experiential fetch bounds", () => {
  const pageOf = (count: number, offset: number): unknown[] =>
    Array.from({ length: count }, (_, index) =>
      catalogEntry(`page-${offset + index}`, [
        { id: "r", capabilities: { supported_reasoning_efforts: ["low"] } },
      ]),
    );

  test("pagination requests limit=1000&offset and stops on a short page", async () => {
    const offsets: string[] = [];
    const limits: string[] = [];
    const fetchImpl = (async (raw: unknown) => {
      const url = new URL(String(raw));
      offsets.push(url.searchParams.get("offset") ?? "");
      limits.push(url.searchParams.get("limit") ?? "");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return offset === 0 ? catalogResponse(pageOf(1000, 0)) : catalogResponse(pageOf(2, 1000));
    }) as typeof fetch;
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, { fetchImpl });
    expect(offsets).toEqual(["0", "1000"]);
    expect(limits).toEqual(["1000", "1000"]);
    expect(map?.size).toBe(1002);
  });

  test("pagination is capped at 10 pages", async () => {
    let requests = 0;
    const offsets: string[] = [];
    const fetchImpl = (async (raw: unknown) => {
      const url = new URL(String(raw));
      requests += 1;
      offsets.push(url.searchParams.get("offset") ?? "");
      return catalogResponse(pageOf(1000, Number(offsets[offsets.length - 1])));
    }) as typeof fetch;
    await fetchExperientialRouteEfforts(caseURL(), 20_000, { fetchImpl });
    expect(requests).toBe(10);
    expect(offsets).toEqual(["0", "1000", "2000", "3000", "4000", "5000", "6000", "7000", "8000", "9000"]);
  });

  test("a failing request is attempted at most twice", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    expect(await fetchExperientialRouteEfforts(caseURL(), 20_000, { fetchImpl })).toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("a retried request succeeds within two attempts", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return attempts === 1 ? new Response("boom", { status: 500 }) : catalogResponse([objA]);
    }) as typeof fetch;
    const map = await fetchExperientialRouteEfforts(caseURL(), 20_000, { fetchImpl });
    expect(attempts).toBe(2);
    expect(map?.get("muse-spark-1.3-contributor")?.efforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

// ---------------------------------------------------------------------------
// TTL, backoff, in-flight dedupe, bypass
// ---------------------------------------------------------------------------

describe("experiential catalog TTL, backoff, and dedupe", () => {
  test("success TTL: reused within the window, refetched after expiry", async () => {
    const url = caseURL();
    let clock = 1_000_000;
    const now = (): number => clock;
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return catalogResponse([objA]);
    }) as typeof fetch;
    const first = await fetchExperientialRouteEfforts(url, 20_000, {
      fetchImpl,
      now,
      ttlSeconds: 900,
    });
    expect(first?.has("muse-spark-1.3-contributor")).toBe(true);
    clock += 899_000;
    expect(await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now, ttlSeconds: 900 })).toBe(first);
    expect(requests).toBe(1);
    clock += 1_000;
    await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now, ttlSeconds: 900 });
    expect(requests).toBe(2);
  });

  test("failure backoff: no poll-cadence retry; eligible again after an hour", async () => {
    const url = caseURL();
    let clock = 5_000_000;
    const now = (): number => clock;
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return new Response("down", { status: 503 });
    }) as typeof fetch;
    expect(await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now })).toBeUndefined();
    expect(attempts).toBe(2);
    clock += 3_599_000;
    expect(await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now })).toBeUndefined();
    expect(attempts).toBe(2);
    clock += 2_000;
    await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now });
    expect(attempts).toBe(4);
  });

  test("keep-last-good: a failed refresh returns the previous map", async () => {
    const url = caseURL();
    let clock = 10_000_000;
    const now = (): number => clock;
    let healthy = true;
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return healthy ? catalogResponse([objA]) : new Response("down", { status: 503 });
    }) as typeof fetch;
    const first = await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now, ttlSeconds: 900 });
    expect(first?.has("muse-spark-1.3-contributor")).toBe(true);
    expect(attempts).toBe(1);
    healthy = false;
    clock += 901_000;
    const second = await fetchExperientialRouteEfforts(url, 20_000, {
      fetchImpl,
      now,
      ttlSeconds: 900,
    });
    expect(attempts).toBe(3); // one failed refresh = two attempts
    expect(second?.get("muse-spark-1.3-contributor")?.efforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    clock += 1_000; // inside the failure backoff
    await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now, ttlSeconds: 900 });
    expect(attempts).toBe(3);
  });

  test("env TTL override applies with a 900s floor", async () => {
    expect(resolveExperientialCatalogTtlSeconds(undefined, undefined)).toBe(
      EXPERIENTIAL_CATALOG_TTL_SECONDS,
    );
    expect(resolveExperientialCatalogTtlSeconds(undefined, "600")).toBe(
      MIN_EXPERIENTIAL_CATALOG_TTL_SECONDS,
    );
    expect(resolveExperientialCatalogTtlSeconds(undefined, "3600")).toBe(3600);
    expect(resolveExperientialCatalogTtlSeconds(7200, "900")).toBe(7200);
    expect(parseExperientialCatalogTtlSeconds(899)).toBe(900);
    expect(parseExperientialCatalogTtlSeconds(0)).toBeUndefined();
    expect(parseExperientialCatalogTtlSeconds("900")).toBeUndefined();
    // And the env value is read by the fetch path: 900s means a refetch at 901s.
    const url = caseURL();
    process.env[EXPERIENTIAL_CATALOG_TTL_ENV] = "900";
    let clock = 20_000_000;
    const now = (): number => clock;
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return catalogResponse([objA]);
    }) as typeof fetch;
    await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now });
    clock += 901_000;
    await fetchExperientialRouteEfforts(url, 20_000, { fetchImpl, now });
    expect(requests).toBe(2);
  });

  test("concurrent callers share one in-flight catalog request", async () => {
    const url = caseURL();
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      requests += 1;
      await gate;
      return catalogResponse([objA]);
    }) as typeof fetch;
    const first = fetchExperientialRouteEfforts(url, 20_000, { fetchImpl });
    const second = fetchExperientialRouteEfforts(url, 20_000, { fetchImpl });
    expect(requests).toBe(1);
    release?.();
    const [mapA, mapB] = await Promise.all([first, second]);
    expect(mapA).toBe(mapB);
    expect(requests).toBe(1);
  });

  test("poll-level TTL: a second poll within the window reuses the catalog map", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=poll-ttl";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]),
    });
    try {
      const first = await pollProvider(explabsTarget());
      const second = await pollProvider(explabsTarget());
      expect(catalogCalls(finish.calls)).toBe(1);
      expect(first?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low"]);
      expect(second?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low"]);
    } finally {
      finish.restore();
    }
  });

  test("force mode bypasses the catalog TTL; merge-like contexts do not", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=bypass";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]),
    });
    try {
      await pollProvider(explabsTarget());
      expect(catalogCalls(finish.calls)).toBe(1);
      await pollProvider(explabsTarget(), undefined, { bypassCatalogTtl: true });
      expect(catalogCalls(finish.calls)).toBe(2);
      // Merge-like contexts keep the TTL: no third fetch.
      await pollProvider(explabsTarget(), undefined, { bypassParameterCache: true });
      expect(catalogCalls(finish.calls)).toBe(2);
    } finally {
      finish.restore();
    }
  });

  test("two concurrent pollProvider calls issue one catalog request", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=dedupe";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: (async () => {
        await gate;
        return catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]);
      }) as never,
    });
    try {
      const first = pollProvider(explabsTarget());
      const second = pollProvider(explabsTarget());
      release?.();
      const [a, b] = await Promise.all([first, second]);
      expect(catalogCalls(finish.calls)).toBe(1);
      expect(a?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low"]);
      expect(b?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low"]);
    } finally {
      finish.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// pollProvider integration
// ---------------------------------------------------------------------------

describe("pollProvider experiential integration", () => {
  test("exact id match only: unmatched models keep their metadata", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=exact-id";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [
            { id: "r1", capabilities: { supported_reasoning_efforts: ["low", "high"] } },
          ]),
        ]),
    });
    try {
      const result = await pollProvider(explabsTarget());
      expect(result?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low", "high"]);
      expect(result?.[1]?.metadata).toBeUndefined();
    } finally {
      finish.restore();
    }
  });

  test("enrich:false issues zero catalog requests", async () => {
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]),
    });
    try {
      const result = await pollProvider({ id: "explabs", baseURL: EXPLABS_BASE });
      expect(catalogCalls(finish.calls)).toBe(0);
      expect(finish.calls).toHaveLength(1);
      expect(result?.[0]?.metadata).toBeUndefined();
    } finally {
      finish.restore();
    }
  });

  test("catalog request is keyless even when the provider target has an apiKey", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=headers";
    const catalogHeaders: Array<Record<string, string> | undefined> = [];
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: (_url, headers) => {
        catalogHeaders.push(headers);
        return catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]);
      },
    });
    try {
      await pollProvider(explabsTarget({ apiKey: "test-key-xyz" }));
      expect(catalogHeaders).toEqual([undefined]);
      const modelsCall = finish.calls.find((call) => call.url.includes("/v1/models"));
      expect(modelsCall?.headers?.Authorization).toBe("Bearer test-key-xyz");
    } finally {
      finish.restore();
    }
  });

  test("catalog failure never fails the poll", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=poll-fail";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] }),
      catalog: () => new Response("boom", { status: 500 }),
    });
    try {
      const result = await pollProvider(explabsTarget());
      expect(result).toHaveLength(2);
      expect(result?.[0]?.metadata).toBeUndefined();
      expect(result?.[1]?.metadata).toBeUndefined();
      expect(catalogCalls(finish.calls)).toBe(2); // one failed request (two attempts), poll intact
    } finally {
      finish.restore();
    }
  });

  test("MiMo poll run: positive routes get variants; wally primary yields no variants and no marker", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=mimo-poll";
    const finish = installFetch({
      models: () =>
        jsonResponse({ data: [{ id: "mimo-v2.5" }, { id: "mimo-v2.5-pro" }, { id: "mimo-v2.6-pro" }] }),
      catalog: () => catalogResponse([mimoV25, mimoV25Pro, mimoV26Pro]),
    });
    try {
      const result = await pollProvider(explabsTarget());
      expect(result?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual([
        "none",
        "low",
        "medium",
        "high",
      ]);
      expect(result?.[1]?.metadata?.variants?.map((variant) => variant.id)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      // UNKNOWN: no variants (never the disabled route's "medium") and no deny marker.
      expect(result?.[2]?.metadata).toBeUndefined();
    } finally {
      finish.restore();
    }
  });

  test("provider-rich variants union with catalog efforts, rich-first", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=union";
    const finish = installFetch({
      models: () =>
        jsonResponse({
          data: [{ id: "m1", reasoning_options: [{ type: "effort", values: ["high"] }] }],
        }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [
            { id: "r1", capabilities: { supported_reasoning_efforts: ["low", "high"] } },
          ]),
        ]),
    });
    try {
      const result = await pollProvider(explabsTarget());
      expect(result?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["high", "low"]);
    } finally {
      finish.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Deny marker semantics
// ---------------------------------------------------------------------------

describe("deny marker semantics", () => {
  const joinCandidate: CatalogJoinCandidate = {
    providerID: "other",
    modelID: "m1",
    provider: { id: "other" },
    model: { id: "m1", reasoning_options: [{ type: "effort", values: ["high"] }] },
  };

  test("resolveModelMetadata: marker suppresses join variants but keeps rich>join fields", () => {
    const denied = resolveModelMetadata(
      "explabs",
      "m1",
      {
        reasoningDenied: true,
        limit: { context: 10, output: 5 },
      },
      [joinCandidate],
    );
    expect(denied.metadata?.reasoningDenied).toBe(true);
    expect(denied.metadata?.variants).toBeUndefined();
    expect(denied.metadata?.limit).toEqual({ context: 10, output: 5 });
    // Control: without the marker the same candidate supplies variants.
    const control = resolveModelMetadata("explabs", "m1", undefined, [joinCandidate]);
    expect(control.provenance).toBe("join");
    expect(control.metadata?.variants?.map((variant) => variant.id)).toEqual(["high"]);
  });

  test("applyDiscovered merge: marker skips the registryJoin fill entirely", () => {
    const joinCalls: string[] = [];
    const registryJoin = (_providerID: string, modelID: string): Array<{ id: string }> => {
      joinCalls.push(modelID);
      return [{ id: "medium" }];
    };
    const deniedRows = new Map<string, Record<string, unknown>>();
    applyDiscovered(
      makeDraft(deniedRows),
      new Map([
        [
          "explabs",
          [
            {
              id: "m-denied",
              enrich: true,
              merge: true,
              metadata: { reasoningDenied: true },
            } as ModelEntry,
          ],
        ],
      ]),
      [],
      { registryJoin },
    );
    expect(deniedRows.get("explabs:m-denied")?.variants).toBeUndefined();
    expect(joinCalls).toEqual([]);
    const controlRows = new Map<string, Record<string, unknown>>();
    applyDiscovered(
      makeDraft(controlRows),
      new Map([["explabs", [{ id: "m-open", enrich: true, merge: true } as ModelEntry]]]),
      [],
      { registryJoin },
    );
    expect(controlRows.get("explabs:m-open")?.variants).toEqual([{ id: "medium" }]);
    expect(joinCalls).toEqual(["m-open"]);
  });

  test("UNKNOWN keeps join behavior: merge gap-fills candidate variants with join provenance", () => {
    const resolution = resolveModelMetadata("explabs", "mimo-v2.6-pro", undefined, [
      {
        providerID: "other",
        modelID: "mimo-v2.6-pro",
        provider: { id: "other" },
        model: { id: "mimo-v2.6-pro", reasoning_options: [{ type: "effort", values: ["medium"] }] },
      },
    ]);
    expect(resolution.provenance).toBe("join");
    expect(resolution.metadata?.variants?.map((variant) => variant.id)).toEqual(["medium"]);
    expect(resolution.metadata?.reasoningDenied).toBeUndefined();
  });

  test("replay: reasoningDenied survives the state round-trip and suppresses the registryJoin replay", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-exp-replay-"));
    try {
      const statePath = path.join(dir, "state.json");
      writeStateFile(
        statePath,
        buildStateFile(
          new Map([
            [
              "explabs",
              withMergedModelIds(
                {
                  lastSuccessMs: 1_000,
                  lastPolledMs: 1_000,
                  modelCount: 1,
                  cacheForSeconds: null,
                  lastTrigger: "poll",
                  models: [
                    {
                      id: "replay-denied",
                      enrich: true as const,
                      metadata: { reasoningDenied: true as const },
                    },
                  ],
                },
                ["replay-denied"],
              ),
            ],
          ]),
        ),
      );
      const state = loadStateFile(statePath);
      const models = state?.providers["explabs"]?.models ?? [];
      expect(models[0]?.metadata?.reasoningDenied).toBe(true);
      const rows = new Map<string, Record<string, unknown>>();
      applyDiscovered(
        makeDraft(rows),
        new Map([["explabs", models]]),
        [],
        {
          mergedModelIds: new Map([["explabs", new Set(["replay-denied"])]]),
          registryJoin: () => [{ id: "medium" }],
        },
      );
      expect(rows.get("explabs:replay-denied")?.variants).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claude-fable-5 deny class replays with join suppressed", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-exp-deny-replay-"));
    try {
      const statePath = path.join(dir, "state.json");
      writeStateFile(
        statePath,
        buildStateFile(
          new Map([
            [
              "explabs",
              withMergedModelIds(
                {
                  lastSuccessMs: 1_000,
                  lastPolledMs: 1_000,
                  modelCount: 1,
                  cacheForSeconds: null,
                  lastTrigger: "poll",
                  models: [
                    {
                      id: "claude-fable-5",
                      enrich: true as const,
                      metadata: { reasoningDenied: true as const },
                    },
                  ],
                },
                ["claude-fable-5"],
              ),
            ],
          ]),
        ),
      );
      const state = loadStateFile(statePath);
      const models = state?.providers["explabs"]?.models ?? [];
      expect(models[0]?.metadata?.reasoningDenied).toBe(true);
      const rows = new Map<string, Record<string, unknown>>();
      applyDiscovered(makeDraft(rows), new Map([["explabs", models]]), [], {
        mergedModelIds: new Map([["explabs", new Set(["claude-fable-5"])]]),
        registryJoin: () => [{ id: "low" }, { id: "medium" }, { id: "high" }],
      });
      expect(rows.get("explabs:claude-fable-5")?.variants).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merge gap-fill never overwrites existing variants", () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["explabs:m1", { variants: [{ id: "keep" }] }],
    ]);
    applyDiscovered(
      makeDraft(rows),
      new Map([
        [
          "explabs",
          [
            {
              id: "m1",
              enrich: true,
              merge: true,
              metadata: { variants: [{ id: "new" }] },
            } as ModelEntry,
          ],
        ],
      ]),
      [],
      {},
    );
    expect(rows.get("explabs:m1")?.variants).toEqual([{ id: "keep" }]);
  });

  test("marker-only metadata composes, parses, and round-trips", () => {
    const parsed = parseModelMetadata({ reasoningDenied: true });
    expect(parsed).toEqual({ reasoningDenied: true });
    expect(parseModelMetadata(parsed)).toEqual({ reasoningDenied: true });
    expect(parseModelMetadata({ reasoningDenied: false })).toBeUndefined();
    expect(
      resolveModelMetadata("explabs", "marker-only", { reasoningDenied: true }, []).metadata,
    ).toEqual({ reasoningDenied: true });
  });

  test("marker is never written to the catalog row (non-merge branch)", () => {
    const rows = new Map<string, Record<string, unknown>>([["explabs:m1", { name: "m1" }]]);
    applyDiscovered(
      makeDraft(rows),
      new Map([
        [
          "explabs",
          [{ id: "m1", enrich: true, metadata: { reasoningDenied: true } } as ModelEntry],
        ],
      ]),
      [],
      {},
    );
    const row = rows.get("explabs:m1") ?? {};
    expect(row.reasoningDenied).toBeUndefined();
    expect(row.variants).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Replay transitions
// ---------------------------------------------------------------------------

describe("replay transitions", () => {
  const denyM1 = (): Record<string, unknown> =>
    catalogEntry("m1", [{ id: "r1", capabilities: { supports_reasoning: false } }]);
  const positiveM1 = (): Record<string, unknown> =>
    catalogEntry("m1", [
      { id: "r1", capabilities: { supported_reasoning_efforts: ["low", "high"] } },
    ]);

  test("stale denial clears: a positive refresh rebuilds entries without the marker", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=stale-clear";
    let catalogState: "deny" | "positive" = "deny";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () => catalogResponse([catalogState === "deny" ? denyM1() : positiveM1()]),
    });
    try {
      const cycle1 = await pollProvider(explabsTarget());
      expect(cycle1?.[0]?.metadata).toEqual({ reasoningDenied: true });
      // Persist cycle 1 exactly as the state file would, then move the catalog to positive.
      const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-exp-stale-"));
      try {
        const statePath = path.join(dir, "state.json");
        writeStateFile(
          statePath,
          buildStateFile(new Map([["explabs", {
            lastSuccessMs: 1_000,
            lastPolledMs: 1_000,
            modelCount: 1,
            cacheForSeconds: null,
            lastTrigger: "poll",
            models: cycle1 as ModelEntry[],
          }]])),
        );
        expect(loadStateFile(statePath)?.providers["explabs"]?.models?.[0]?.metadata?.reasoningDenied).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      catalogState = "positive";
      // Cycle 2 with a forced catalog refresh (rescan semantics): the marker must not leak.
      const cycle2 = await pollProvider(explabsTarget(), undefined, { bypassCatalogTtl: true });
      expect(cycle2?.[0]?.metadata?.reasoningDenied).toBeUndefined();
      expect(cycle2?.[0]?.metadata?.variants?.map((variant) => variant.id)).toEqual(["low", "high"]);
      // The merge replay gap-fills the fresh efforts and never the marker.
      const rows = new Map<string, Record<string, unknown>>([["explabs:m1", { name: "m1" }]]);
      applyDiscovered(makeDraft(rows), new Map([["explabs", cycle2 ?? []]]), [], {
        mergedModelIds: new Map([["explabs", new Set(["m1"])]]),
        registryJoin: () => [{ id: "medium" }],
      });
      expect(rows.get("explabs:m1")?.variants?.map((variant: any) => variant.id)).toEqual([
        "low",
        "high",
      ]);
      expect(rows.get("explabs:m1")?.reasoningDenied).toBeUndefined();
    } finally {
      finish.restore();
    }
  });

  test("catalog-fetch failure holds the last-good deny through the cycle", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=hold";
    let healthy = true;
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () => (healthy ? catalogResponse([denyM1()]) : new Response("down", { status: 503 })),
    });
    try {
      const cycle1 = await pollProvider(explabsTarget());
      expect(cycle1?.[0]?.metadata).toEqual({ reasoningDenied: true });
      healthy = false;
      const cycle2 = await pollProvider(explabsTarget(), undefined, { bypassCatalogTtl: true });
      expect(cycle2?.[0]?.metadata).toEqual({ reasoningDenied: true });
      // The persisted/replayed marker still blocks registryJoin guesses.
      const joinCalls: string[] = [];
      const rows = new Map<string, Record<string, unknown>>();
      applyDiscovered(makeDraft(rows), new Map([["explabs", cycle2 ?? []]]), [], {
        mergedModelIds: new Map([["explabs", new Set(["m1"])]]),
        registryJoin: (_providerID, modelID) => {
          joinCalls.push(modelID);
          return [{ id: "medium" }];
        },
      });
      expect(rows.get("explabs:m1")?.variants).toBeUndefined();
      expect(joinCalls).toEqual([]);
    } finally {
      finish.restore();
    }
  });

  test("cold replay before any catalog success blocks registryJoin", () => {
    const joinCalls: string[] = [];
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-exp-cold-"));
    try {
      const statePath = path.join(dir, "state.json");
      writeStateFile(
        statePath,
        buildStateFile(
          new Map([
            [
              "explabs",
              withMergedModelIds(
                {
                  lastSuccessMs: 1_000,
                  lastPolledMs: 1_000,
                  modelCount: 1,
                  cacheForSeconds: null,
                  lastTrigger: "poll",
                  models: [
                    {
                      id: "m1",
                      enrich: true as const,
                      metadata: { reasoningDenied: true as const },
                    },
                  ],
                },
                ["m1"],
              ),
            ],
          ]),
        ),
      );
      const models = loadStateFile(statePath)?.providers["explabs"]?.models ?? [];
      const rows = new Map<string, Record<string, unknown>>();
      applyDiscovered(makeDraft(rows), new Map([["explabs", models]]), [], {
        mergedModelIds: new Map([["explabs", new Set(["m1"])]]),
        registryJoin: (_providerID, modelID) => {
          joinCalls.push(modelID);
          return [{ id: "medium" }];
        },
      });
      expect(rows.get("explabs:m1")?.variants).toBeUndefined();
      expect(joinCalls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown-id merge press offers candidate join variants only", async () => {
    process.env[EXPERIENTIAL_CATALOG_URL_ENV] = "https://api.experientiallabs.ai/api/models?case=unknown-merge";
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "mimo-v2.6-pro" }] }),
      catalog: () => catalogResponse([mimoV26Pro]),
    });
    try {
      // Automatic cycle: no variants, no marker, no gateway-support claim.
      const automatic = await pollProvider(explabsTarget());
      expect(automatic?.[0]?.metadata).toBeUndefined();
      const candidate: CatalogJoinCandidate = {
        providerID: "other",
        modelID: "mimo-v2.6-pro",
        provider: { id: "other" },
        model: {
          id: "mimo-v2.6-pro",
          reasoning_options: [{ type: "effort", values: ["medium"] }],
        },
      };
      const resolution = resolveModelMetadata(
        "explabs",
        "mimo-v2.6-pro",
        automatic?.[0]?.metadata,
        [candidate],
      );
      expect(resolution.provenance).toBe("join");
      expect(resolution.provenance).not.toBe("provider-rich");
      expect(resolution.metadata?.reasoningDenied).toBeUndefined();
      // Explicit merge press: the candidate arrives as a gap-fill with join provenance.
      const rows = new Map<string, Record<string, unknown>>();
      applyDiscovered(
        makeDraft(rows),
        new Map([
          [
            "explabs",
            (automatic ?? []).map((entry) => ({ ...entry, merge: true as const })),
          ],
        ]),
        [],
        { registryJoin: () => resolution.metadata?.variants },
      );
      expect(rows.get("explabs:mimo-v2.6-pro")?.variants).toEqual([
        { id: "medium", settings: { reasoningEffort: "medium" } },
      ]);
      expect(rows.get("explabs:mimo-v2.6-pro")?.reasoningDenied).toBeUndefined();
    } finally {
      finish.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Real-setting cost: catalog GETs happen only inside a poll that runs
// ---------------------------------------------------------------------------

describe("real-setting cost", () => {
  /** Isolate every config source from the operator's real files (scratch only). */
  function isolatePluginEnv(dir: string): () => void {
    const previousCwd = process.cwd();
    const previousEnv = {
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      HOME: process.env.HOME,
    };
    const restore = (): void => {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    fs.writeFileSync(
      path.join(dir, "explicit.json"),
      JSON.stringify({
        providers: {
          explabs: {
            package: "aisdk:@ai-sdk/openai-compatible",
            options: {
              baseURL: EXPLABS_BASE,
              modelsDiscovery: { enrich: true },
            },
          },
        },
      }),
    );
    process.env.OPENCODE_CONFIG = path.join(dir, "explicit.json");
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);
    return restore;
  }

  function writeFreshState(statePath: string, modelID: string): void {
    const now = Date.now();
    writeStateFile(
      statePath,
      buildStateFile(
        new Map([
          [
            "explabs",
            {
              lastSuccessMs: now - 10_000,
              lastPolledMs: now - 10_000,
              modelCount: 1,
              cacheForSeconds: 86_400,
              lastTrigger: "poll" as const,
              models: [{ id: modelID, enrich: true as const }],
            },
          ],
        ]),
      ),
    );
  }

  test("a TTL-skipped cycle issues zero catalog requests", async () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-cost-skip-"));
    const restoreEnv = isolatePluginEnv(dir);
    const previousStateFile = process.env[STATE_FILE_ENV];
    const previousSetInterval = globalThis.setInterval;
    process.env[STATE_FILE_ENV] = path.join(dir, "state.json");
    (globalThis as any).setInterval = (): number => 1;
    setModelsDevRegistryForTests(new Map());
    writeFreshState(process.env[STATE_FILE_ENV] as string, "m1");
    const rows = new Map<string, Record<string, unknown>>();
    let registered: ((draft: any) => void) | undefined;
    const finish = installFetch({ models: () => jsonResponse({ data: [{ id: "m1" }] }) });
    try {
      const cleanup = await setup({
        options: { cacheFor: 86_400 },
        catalog: {
          transform: async (callback: (draft: any) => void) => {
            registered = callback;
            return { dispose: async () => {} };
          },
          reload: async () => {
            registered?.(makeDraft(rows));
          },
        },
      } as any);
      // The explabs auto target was discovered and its rehydrated model reached
      // the catalog transform — with zero network calls anywhere: fresh models
      // TTL (the owner's global cacheFor=86400) means the boot cycle polls
      // nothing, so it must ask the catalog nothing either.
      expect(rows.has("explabs:m1")).toBe(true);
      expect(finish.calls).toEqual([]);
      expect(catalogCalls(finish.calls)).toBe(0);
      await cleanup?.();
    } finally {
      finish.restore();
      (globalThis as any).setInterval = previousSetInterval;
      if (previousStateFile === undefined) delete process.env[STATE_FILE_ENV];
      else process.env[STATE_FILE_ENV] = previousStateFile;
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("force mode issues exactly one catalog GET per rescan press", async () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "cmd-sd-cost-force-"));
    const restoreEnv = isolatePluginEnv(dir);
    const previousStateFile = process.env[STATE_FILE_ENV];
    const previousSetInterval = globalThis.setInterval;
    process.env[STATE_FILE_ENV] = path.join(dir, "state.json");
    (globalThis as any).setInterval = (): number => 1;
    setModelsDevRegistryForTests(new Map());
    writeFreshState(process.env[STATE_FILE_ENV] as string, "m1");
    const finish = installFetch({
      models: () => jsonResponse({ data: [{ id: "m1" }] }),
      catalog: () =>
        catalogResponse([
          catalogEntry("m1", [{ id: "r1", capabilities: { supported_reasoning_efforts: ["low"] } }]),
        ]),
    });
    let registered:
      | { name: string; execute: (context?: unknown) => Promise<void> | void }
      | undefined;
    try {
      const cleanup = await setup({
        options: { cacheFor: 86_400 },
        catalog: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
        command: {
          transform: async (callback: (draft: { add(command: unknown): void }) => void) => {
            callback({
              add: (command: unknown) => {
                const candidate = command as {
                  name: string;
                  execute: (context?: unknown) => Promise<void> | void;
                };
                if (candidate.name === "models-discovery-rescan") registered = candidate;
              },
            });
            return { dispose: async () => {} };
          },
        },
      } as any);
      expect(catalogCalls(finish.calls)).toBe(0); // TTL-fresh boot: no poll
      await registered!.execute({}); // force press bypasses interval + TTLs
      expect(catalogCalls(finish.calls)).toBe(1);
      await registered!.execute({});
      expect(catalogCalls(finish.calls)).toBe(2);
      await cleanup?.();
    } finally {
      finish.restore();
      (globalThis as any).setInterval = previousSetInterval;
      if (previousStateFile === undefined) delete process.env[STATE_FILE_ENV];
      else process.env[STATE_FILE_ENV] = previousStateFile;
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});