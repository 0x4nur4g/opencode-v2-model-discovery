import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_CACHE_FOR_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  MIN_POLL_TIMEOUT_SECONDS,
  POLL_TIMEOUT_MS,
  applyDiscovered,
  buildCatalogJoin,
  buildRefreshSummary,
  computeDueTargets,
  createConfigWatch,
  createStoreAuthResolver,
  discoveredModelName,
  entryMatches,
  extractEntries,
  formatRescanAck,
  mergeProviderConfigs,
  mergeTargets,
  parseCacheForSeconds,
  parseIntervalSeconds,
  parseJsonc,
  parseModelMetadata,
  parsePollTimeoutSeconds,
  pollProvider,
  reconcileOwnedModelIds,
  requestImmediateRefresh,
  resetWarnedAuthEnvIds,
  resetWarnedCacheForKeys,
  resetWarnedIntervalKeys,
  resetWarnedParametersKeys,
  resetWarnedPollTimeoutKeys,
  resetWarnedWatchPaths,
  retainLastGood,
  resolveCacheForSeconds,
  resolveConfigPaths,
  resolveConfigSources,
  resolveIntegrationCredential,
  resolveIntervalSeconds,
  resolveModelMetadata,
  resolveParametersPath,
  resolvePollTimeoutSeconds,
  selectAutoTargets,
  setImmediateRefreshHook,
  setup,
} from "opencode-v2-model-discovery";
import type { ModelEntry } from "opencode-v2-model-discovery";
import {
  STATE_FILE_ENV,
  buildStateFile,
  loadStateFile,
  resolveStateFilePath,
  writeStateFile,
} from "./state.ts";

function catalogModel(name: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 100, output: 10 },
    variants: [],
    ...metadata,
  };
}

/** Stub global fetch, capturing request headers; restores on call. */
function stubFetch(): () => Record<string, string | undefined> {
  let captured: Record<string, string | undefined> = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    captured = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
    return captured;
  };
}

function catalogRecord(
  providerID: string,
  models: Record<string, Record<string, unknown>>,
  activation?: string,
): any {
  return {
    provider: {
      id: providerID,
      name: providerID,
      package: `builtin:${providerID}`,
      ...(activation ? { activation } : {}),
      ...(activation === "enabled" ? { integrationID: providerID } : {}),
    },
    models: new Map(Object.entries(models)),
  };
}

// Per-test state-file isolation: setup() writes the discovery state file at
// `${XDG_STATE_HOME:-~/.local/state}/opencode/model-discovery/state.json`;
// every test pins OPENCODE_MODELS_DISCOVERY_STATE_FILE to a fresh temp path so
// no test ever reads or writes the real user state dir.
const isolatedStateDirs: string[] = [];
let isolatedStatePath = "";
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-state-*"));
  isolatedStateDirs.push(dir);
  isolatedStatePath = path.join(dir, "opencode", "model-discovery", "state.json");
  fs.mkdirSync(path.dirname(isolatedStatePath), { recursive: true });
  process.env[STATE_FILE_ENV] = isolatedStatePath;
});
afterAll(() => {
  for (const dir of isolatedStateDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractEntries", () => {
  test("parses the OpenAI data response shape and skips invalid entries", () => {
    expect(
      extractEntries({
        data: [
          { id: "chat-a", name: "Chat A" },
          { id: "chat-b" },
          { id: "" },
          { id: 42 },
          null,
        ],
      }),
    ).toEqual([
      { id: "chat-a", name: "Chat A" },
      { id: "chat-b", name: undefined },
    ]);
  });

  test("parses the alternate models response shape", () => {
    expect(extractEntries({ models: [{ id: "model-a", name: "Model A" }] })).toEqual([
      { id: "model-a", name: "Model A" },
    ]);
  });

  test("gates direct metadata behind enrichment and preserves SDK fields", () => {
    const body = {
      data: [
        {
          id: "rich-direct",
          name: "Rich Direct",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          limit: { context: 128000, input: 4000, output: 2000 },
          variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
        },
      ],
    };

    expect(extractEntries(body)).toEqual([{ id: "rich-direct", name: "Rich Direct" }]);
    expect(extractEntries(body, true)).toEqual([
      {
        id: "rich-direct",
        name: "Rich Direct",
        metadata: {
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          limit: { context: 128000, input: 4000, output: 2000 },
          variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
        },
      },
    ]);
  });

  test("maps structured modalities, limits, and reasoning efforts", () => {
    const entries = extractEntries(
      {
        models: [
          {
            id: "openrouter/rich",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            top_provider: { context_length: 128000, max_completion_tokens: 4096 },
            reasoning: { supported_efforts: ["low", "high"] },
          },
        ],
      },
      true,
    );

    expect(entries?.[0]).toMatchObject({
      metadata: {
        capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 4096 },
        variants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          { id: "high", settings: { reasoningEffort: "high" } },
        ],
      },
    });
  });

  test("ignores malformed metadata and bare reasoning flags", () => {
    expect(
      parseModelMetadata({
        capabilities: { tools: "yes", input: ["text"], output: ["text"] },
        limit: { context: "large", output: 100 },
        variants: [{ id: 42 }],
        reasoning: { supported_efforts: ["low", 42] },
      }),
    ).toBeUndefined();
    expect(parseModelMetadata({ reasoning: true })).toBeUndefined();
  });

  test("converts only explicit supported efforts into reasoning variants", () => {
    expect(parseModelMetadata({ reasoning: { supported_efforts: ["minimal", "high"] } })).toEqual({
      variants: [
        { id: "minimal", settings: { reasoningEffort: "minimal" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    });
  });

  test("derives tools from Baseten supported_features without inferring variants", () => {
    const metadata = parseModelMetadata({
      id: "deepseek-ai/DeepSeek-V4.1-Flash",
      name: "DeepSeek V4.1 Flash",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_length: 1000000,
      max_completion_tokens: 32000,
      supported_features: ["tools", "json_mode", "structured_outputs", "reasoning", "reasoning_effort"],
    });
    expect(metadata).toMatchObject({
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 32000 },
    });
    expect(metadata?.variants).toBeUndefined();
  });

  test("keeps explicit boolean tools signals ahead of supported_features", () => {
    const recordLevel = parseModelMetadata({
      id: "baseten/boolean-false",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tools: false,
      supported_features: ["tools"],
    });
    const sourceLevel = parseModelMetadata({
      id: "baseten/architecture-boolean-false",
      architecture: { input_modalities: ["text"], output_modalities: ["text"], tools: false },
      supported_features: ["tools"],
    });
    expect(recordLevel?.capabilities?.tools).toBe(false);
    expect(sourceLevel?.capabilities?.tools).toBe(false);
  });

  test("returns undefined for malformed or unrecognized response bodies", () => {
    for (const body of [undefined, null, {}, { data: "not-a-list" }, { models: {} }]) {
      expect(extractEntries(body)).toBeUndefined();
    }
  });
});

describe("additional_attributes reasoning efforts", () => {
  test("parses reasoning_efforts CSV values into effort variants", () => {
    expect(
      parseModelMetadata({ additional_attributes: { reasoning_efforts: "none,minimal, low ,   ,high" } }),
    ).toEqual({
      variants: [
        { id: "none", settings: { reasoningEffort: "none" } },
        { id: "minimal", settings: { reasoningEffort: "minimal" } },
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    });
  });

  test("ignores empty, whitespace-only, non-string, and non-record inputs without crashing", () => {
    expect(parseModelMetadata({ additional_attributes: { reasoning_efforts: "" } })).toBeUndefined();
    expect(
      parseModelMetadata({ additional_attributes: { reasoning_efforts: "   " } }),
    ).toBeUndefined();
    expect(parseModelMetadata({ additional_attributes: { reasoning_efforts: ["low"] } })).toBeUndefined();
    expect(
      parseModelMetadata({ additional_attributes: { reasoning_efforts: 42 } }),
    ).toBeUndefined();
    expect(parseModelMetadata({ additional_attributes: "low,high" })).toBeUndefined();
    expect(parseModelMetadata({ additional_attributes: ["low", "high"] })).toBeUndefined();
  });

  test("dedupes additional_attributes efforts against reasoning supported_efforts", () => {
    expect(
      parseModelMetadata({
        reasoning: { supported_efforts: ["low", "medium"] },
        additional_attributes: { reasoning_efforts: "low,high" },
      }),
    ).toEqual({
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    });
  });
});

describe("parseJsonc", () => {
  test("accepts line/block comments and trailing commas without changing literal strings", () => {
    expect(
      parseJsonc(`{
        // line comment
        "endpoint": "https://fake.invalid/v1//literal",
        /* block comment */
        "pattern": "keep /* and // inside a string",
        "models": ["model-a",],
      }`),
    ).toEqual({
      endpoint: "https://fake.invalid/v1//literal",
      pattern: "keep /* and // inside a string",
      models: ["model-a"],
    });
  });

  test("rejects malformed JSONC after comment removal", () => {
    expect(() => parseJsonc('{ "provider":, /* malformed */ }')).toThrow();
    expect(() => parseJsonc("{ /* unterminated comment\n  \"provider\": {}\n")).toThrow();
  });
});

describe("entryMatches", () => {
  test("matches filter substrings and accepts an omitted filter", () => {
    const entry = { id: "provider-chat-large" };
    expect(entryMatches(entry, "chat")).toBe(true);
    expect(entryMatches(entry, "embedding")).toBe(false);
    expect(entryMatches(entry, undefined)).toBe(true);
  });
});

describe("target precedence and retention", () => {
  test("manual targets win when provider IDs collide", () => {
    const auto = { id: "shared", baseURL: "https://auto.example/v1" };
    const manual = { id: "shared", baseURL: "https://manual.example/v1", filter: "chat" };

    expect(mergeTargets([manual], [auto])).toEqual([manual]);
  });

  test("retains failed polls but replaces state after a successful empty poll", () => {
    const previous = new Map([[
      "shared",
      [{ id: "previous-model" }],
    ]]);

    const afterFailure = retainLastGood(previous, "shared", undefined);
    expect(afterFailure.get("shared")).toEqual([{ id: "previous-model" }]);
    expect(previous.get("shared")).toEqual([{ id: "previous-model" }]);

    const afterSuccessfulEmptyPoll = retainLastGood(previous, "shared", []);
    expect(afterSuccessfulEmptyPoll.get("shared")).toEqual([]);
  });

  test("reconciles plugin-owned IDs independently from enriched model metadata", () => {
    const ownership = reconcileOwnedModelIds(
      new Set(["keep", "vanish"]),
      [
        {
          id: "keep",
          enrich: true,
          metadata: {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 1000, output: 100 },
            variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
          },
        },
        {
          id: "new",
          enrich: true,
          metadata: { variants: [{ id: "low", settings: { reasoningEffort: "low" } }] },
        },
      ],
    );

    expect([...ownership.retained]).toEqual(["keep"]);
    expect([...ownership.removed]).toEqual(["vanish"]);
  });
});

describe("config source resolution", () => {
  test("resolves exact source order and lets the project collision win", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-unit-"));
    try {
      const explicitConfig = path.join(root, "explicit.json");
      const xdgConfigHome = path.join(root, "xdg");
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const xdgConfig = path.join(xdgConfigHome, "opencode", "opencode.json");
      const homeConfig = path.join(home, ".config", "opencode", "opencode.json");
      const projectConfig = path.join(project, "opencode.json");

      const writeConfig = (file: string, provider: Record<string, Record<string, unknown>>): void => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ provider }, null, 2));
      };
      writeConfig(explicitConfig, {
        collision: { source: "explicit" },
        "explicit-only": { source: "explicit" },
      });
      writeConfig(xdgConfig, {
        collision: { source: "xdg" },
        "xdg-only": { source: "xdg" },
      });
      writeConfig(homeConfig, {
        collision: { source: "home" },
        "home-only": { source: "home" },
      });
      writeConfig(projectConfig, {
        collision: { source: "project" },
        "project-only": { source: "project" },
      });

      const paths = resolveConfigPaths({
        opencodeConfig: explicitConfig,
        xdgConfigHome,
        home,
        cwd: project,
      });
      expect(paths).toEqual([explicitConfig, xdgConfig, homeConfig, projectConfig]);
      expect(paths.every((file) => file.startsWith(root))).toBe(true);

      const merged = mergeProviderConfigs(
        paths.map((file) => {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
            provider: Record<string, Record<string, unknown>>;
          };
          return parsed.provider;
        }),
      );
      expect(Object.keys(merged).sort()).toEqual([
        "collision",
        "explicit-only",
        "home-only",
        "project-only",
        "xdg-only",
      ]);
      expect(merged.collision).toEqual({ source: "project" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves every source in documented order and deep-merges inline overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-sources-"));
    try {
      const explicitConfig = path.join(root, "explicit.json");
      const configDir = path.join(root, "config-dir");
      const xdgConfigHome = path.join(root, "xdg");
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const write = (file: string, value: unknown): void => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
      };
      const providerConfig = (source: string, key: string) => ({
        provider: {
          shared: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: source,
              source,
              nested: { [key]: true },
            },
          },
          [`${key}-only`]: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${source}-only` },
          },
        },
      });

      write(explicitConfig, providerConfig("explicit", "explicit"));
      write(path.join(configDir, "opencode.json"), providerConfig("config-dir-json", "configDirJson"));
      write(
        path.join(configDir, "opencode.jsonc"),
        `/* config-dir JSONC */ ${JSON.stringify(providerConfig("config-dir-jsonc", "configDirJsonc")).replace(/}$/, ",}")}`,
      );
      write(path.join(xdgConfigHome, "opencode", "opencode.json"), providerConfig("xdg-json", "xdgJson"));
      write(
        path.join(xdgConfigHome, "opencode", "opencode.jsonc"),
        `// XDG JSONC\n${JSON.stringify(providerConfig("xdg-jsonc", "xdgJsonc"))}`,
      );
      write(path.join(home, ".config", "opencode", "opencode.json"), providerConfig("home-json", "homeJson"));
      write(
        path.join(home, ".config", "opencode", "opencode.jsonc"),
        JSON.stringify(providerConfig("home-jsonc", "homeJsonc")),
      );
      write(path.join(project, "opencode.json"), providerConfig("project-json", "projectJson"));
      write(
        path.join(project, "opencode.jsonc"),
        JSON.stringify(providerConfig("project-jsonc", "projectJsonc")),
      );
      write(path.join(project, ".opencode", "opencode.json"), providerConfig("dot-json", "dotJson"));
      write(
        path.join(project, ".opencode", "opencode.jsonc"),
        JSON.stringify(providerConfig("dot-jsonc", "dotJsonc")),
      );
      const inlineContent = JSON.stringify(providerConfig("inline", "inline"));

      const options = {
        opencodeConfig: explicitConfig,
        opencodeConfigDir: configDir,
        opencodeConfigContent: inlineContent,
        xdgConfigHome,
        home,
        cwd: project,
      };
      const sources = resolveConfigSources(options);
      expect(sources.map((source) => source.marker)).toEqual([
        "explicit",
        "config-dir",
        "config-dir",
        "xdg",
        "xdg",
        "home",
        "home",
        "project",
        "project",
        "project-opencode",
        "project-opencode",
        "inline",
      ]);
      expect(sources.every((source) => source.kind === "content" || source.path?.startsWith(root))).toBe(true);

      const providerMaps = sources.map((source) => {
        const raw = source.kind === "content" ? source.content ?? "" : fs.readFileSync(source.path!, "utf8");
        return (parseJsonc(raw) as { provider: Record<string, Record<string, unknown>> }).provider;
      });
      const merged = mergeProviderConfigs(providerMaps);
      expect(merged.shared).toEqual({
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "inline",
          source: "inline",
          nested: {
            explicit: true,
            configDirJson: true,
            configDirJsonc: true,
            xdgJson: true,
            xdgJsonc: true,
            homeJson: true,
            homeJsonc: true,
            projectJson: true,
            projectJsonc: true,
            dotJson: true,
            dotJsonc: true,
            inline: true,
          },
        },
      });
      expect(Object.keys(merged).sort()).toEqual([
        "configDirJson-only",
        "configDirJsonc-only",
        "dotJson-only",
        "dotJsonc-only",
        "explicit-only",
        "homeJson-only",
        "homeJsonc-only",
        "inline-only",
        "projectJson-only",
        "projectJsonc-only",
        "shared",
        "xdgJson-only",
        "xdgJsonc-only",
      ]);

      const projectDisabled = resolveConfigSources({ ...options, projectConfigDisabled: true });
      expect(projectDisabled.some((source) => source.marker.startsWith("project"))).toBe(false);
      expect(projectDisabled.at(-1)?.marker).toBe("inline");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("provider config shapes and discovery defaults", () => {
  test("selects legacy and native provider maps with their modelsDiscovery locations", () => {
    const selection = selectAutoTargets(
      {
        "legacy-forced": {
          npm: "@ai-sdk/other",
          options: {
            baseURL: "https://legacy.example/gateway",
            modelsDiscovery: { enabled: true, endpoint: "/catalog" },
          },
        },
        "legacy-disabled": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://legacy.example/v1", modelsDiscovery: false },
        },
        "native-forced": {
          package: "@ai-sdk/other",
          settings: {
            baseURL: "https://native.example/gateway",
            modelsDiscovery: { enabled: true, endpoint: "/models-list" },
          },
        },
        "native-disabled": {
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: "https://native.example/v1", modelsDiscovery: false },
        },
        "native-compatible": {
          package: "@ai-sdk/other",
          settings: { baseURL: "https://native.example/v1" },
        },
      },
      new Set(),
      {},
    );

    expect(selection.targets.map((target) => target.id)).toEqual([
      "legacy-forced",
      "native-forced",
      "native-compatible",
    ]);
    expect(selection.targets[0]?.pollURL).toBe("https://legacy.example/catalog");
    expect(selection.targets[1]?.pollURL).toBe("https://native.example/models-list");
    expect(selection.targets[2]?.baseURL).toBe("https://native.example/v1");
  });

  test("targets native-only package/settings config and honors its enabled state", () => {
    const selection = selectAutoTargets(
      {
        "native-only": {
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: "https://native.example/gateway" },
        },
        "native-disabled": {
          package: "@ai-sdk/openai-compatible",
          settings: {
            baseURL: "https://disabled.example/gateway",
            modelsDiscovery: false,
          },
        },
      },
      new Set(),
      {},
    );

    expect(selection.targets.map((target) => target.id)).toEqual(["native-only"]);
    expect(selection.targets[0]).toMatchObject({
      id: "native-only",
      baseURL: "https://native.example/gateway",
      pollURL: "https://native.example/gateway/models",
    });
  });

  test("opts into enrichment for object flags without changing boolean compatibility", () => {
    const selection = selectAutoTargets(
      {
        rich: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://rich.example/v1",
            modelsDiscovery: { enabled: true, enrich: true },
          },
        },
        settingsRich: {
          package: "@ai-sdk/openai-compatible",
          settings: {
            baseURL: "https://settings-rich.example/v1",
            modelsDiscovery: { enabled: true, enrich: true },
          },
        },
        topLevelRich: {
          package: "@ai-sdk/openai-compatible",
          baseURL: "https://top-level-rich.example/v1",
          modelsDiscovery: { enabled: true, enrich: true },
        },
        implicitRich: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://implicit-rich.example/v1", modelsDiscovery: { enrich: true } },
        },
        objectNameOnly: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://object.example/v1", modelsDiscovery: { enabled: true } },
        },
        booleanNameOnly: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://boolean.example/v1", modelsDiscovery: true },
        },
        disabled: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://disabled.example/v1",
            modelsDiscovery: { enabled: false, enrich: true },
          },
        },
      },
      new Set(),
      {},
    );

    expect(selection.targets.map((target) => target.id)).toEqual([
      "rich",
      "settingsRich",
      "topLevelRich",
      "implicitRich",
      "objectNameOnly",
      "booleanNameOnly",
    ]);
    expect(selection.targets.map((target) => target.enrich)).toEqual([
      true,
      true,
      true,
      true,
      undefined,
      undefined,
    ]);
  });

  test("uses compatibility default when unset and honors true/false overrides", () => {
    const providers = {
      compatible: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://compatible.example/v1" },
      },
      other: {
        npm: "@ai-sdk/other",
        options: { baseURL: "https://other.example/gateway" },
      },
      explicit: {
        npm: "@ai-sdk/other",
        options: { baseURL: "https://explicit.example/gateway", modelsDiscovery: true },
      },
      explicitOff: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://off.example/v1", modelsDiscovery: false },
      },
    };

    expect(selectAutoTargets(providers, new Set(), {}).targets.map((target) => target.id)).toEqual([
      "compatible",
      "explicit",
    ]);
    expect(
      selectAutoTargets(providers, new Set(), {
        OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED: "true",
      }).targets.map((target) => target.id),
    ).toEqual(["compatible", "other", "explicit"]);
    expect(
      selectAutoTargets(providers, new Set(), {
        OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED: "false",
      }).targets.map((target) => target.id),
    ).toEqual(["explicit"]);
  });
});

describe("catalog enrichment", () => {
  test("resolves exact ids, unique suffixes, and builtin collision preference", () => {
    const candidates = buildCatalogJoin([
      catalogRecord("exact-provider", { "exact-model": catalogModel("Exact") }),
      catalogRecord("suffix-provider", { "suffix-model": catalogModel("Suffix") }),
      catalogRecord("collision-a", { shared: catalogModel("A") }),
      catalogRecord("collision-b", { shared: catalogModel("B") }),
      catalogRecord("builtin-provider", { builtin: catalogModel("Builtin") }, "enabled"),
      catalogRecord("other-provider", { builtin: catalogModel("Other") }),
    ]);

    expect(resolveModelMetadata("target", "exact-model", undefined, candidates).provenance).toBe(
      "join",
    );
    expect(
      resolveModelMetadata("target", "vendor/suffix-model", undefined, candidates).provenance,
    ).toBe("join");
    expect(
      resolveModelMetadata("target", "vendor/shared", undefined, candidates).provenance,
    ).toBe("name-only");
    expect(
      resolveModelMetadata("target", "vendor/builtin", undefined, candidates).provenance,
    ).toBe("join");
  });

  test("merges provider-rich and join per field with meaningful provenance", () => {
    const candidates = buildCatalogJoin([
      catalogRecord(
        "builtin-provider",
        {
          shared: catalogModel("Builtin", {
            capabilities: undefined,
            limit: undefined,
            variants: [{ id: "join-high", settings: { reasoningEffort: "join-high" } }],
          }),
        },
        "enabled",
      ),
    ]);
    const rich = { capabilities: { tools: true, input: ["text"], output: ["text"] } };

    // provider-rich wins the field it supplies; the join supplies the rest.
    const merged = resolveModelMetadata("target", "shared", rich, candidates);
    expect(merged.provenance).toBe("mixed");
    expect(merged.metadata).toMatchObject({
      capabilities: rich.capabilities,
      variants: [{ id: "join-high", settings: { reasoningEffort: "join-high" } }],
    });

    // rich covering every provided field stays provider-rich.
    const richFull = {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "rich", settings: { reasoningEffort: "rich" } }],
    };
    expect(resolveModelMetadata("target", "shared", richFull, candidates).provenance).toBe(
      "provider-rich",
    );

    // no provider-rich: join-only provenance.
    expect(resolveModelMetadata("target", "shared", undefined, candidates).provenance).toBe("join");

    // no match at all: name-only.
    expect(resolveModelMetadata("target", "missing", undefined, candidates).provenance).toBe(
      "name-only",
    );
  });

  test("provider-rich limit fills join-only variants per field", () => {
    const candidates = buildCatalogJoin([
      catalogRecord(
        "builtin-provider",
        {
          shared: catalogModel("Builtin", {
            variants: [{ id: "join-low", settings: { reasoningEffort: "join-low" } }],
          }),
        },
        "enabled",
      ),
    ]);
    const resolution = resolveModelMetadata(
      "target",
      "shared",
      { limit: { context: 1000, output: 50 } },
      candidates,
    );
    expect(resolution.provenance).toBe("mixed");
    expect(resolution.metadata).toMatchObject({
      limit: { context: 1000, output: 50 },
      variants: [{ id: "join-low", settings: { reasoningEffort: "join-low" } }],
    });
  });

  test("maps catalog reasoning_options effort values into variants", () => {
    const candidates = buildCatalogJoin([
      catalogRecord("builtin-provider", {
        effort: catalogModel("Effort", {
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        }),
      }),
    ]);

    expect(resolveModelMetadata("target", "effort", undefined, candidates).metadata).toMatchObject({
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    });
  });

  test("updates rich fields while preserving explicit names and gates joins", () => {
    const richModel = {
      name: "Configured name",
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      limit: { context: 10, output: 2 },
      variants: [],
    } as any;
    const nameOnlyModel = {
      name: "Configured name",
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      limit: { context: 10, output: 2 },
      variants: [],
    } as any;
    const updated: Array<any> = [];
    const draft = {
      provider: { list: () => [], get: () => undefined, update: () => {}, remove: () => {} },
      model: {
        get: () => undefined,
        update: (_providerID: string, modelID: string, update: (model: any) => void) => {
          const model = modelID === "rich" ? richModel : nameOnlyModel;
          update(model);
          updated.push(model);
        },
        remove: () => {},
        default: { get: () => undefined, set: () => {} },
      },
    } as any;
    const metadata = {
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000, input: 100, output: 50 },
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    };

    applyDiscovered(
      draft,
      new Map([
        [
          "target",
          [
            { id: "rich", name: "Discovered", enrich: true as const, metadata },
            { id: "name-only", name: "Discovered", metadata },
          ],
        ],
      ]),
    );

    expect(updated[0]).toMatchObject({ name: "Configured name", ...metadata });
    expect(updated[1]).toMatchObject({
      name: "Configured name",
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      limit: { context: 10, output: 2 },
      variants: [],
    });
  });
});

describe("discovered model names", () => {
  test("preserves custom names and updates absent or id-equal names", () => {
    expect(discoveredModelName("Custom display name", "model-a", "Discovered A")).toBe(
      "Custom display name",
    );
    expect(discoveredModelName("model-a", "model-a", "Discovered A")).toBe("Discovered A");
    expect(discoveredModelName(undefined, "model-a", undefined)).toBe("model-a");
  });
});

describe("auth key resolution", () => {
  const acmeProvider = (options: Record<string, unknown>): Record<string, unknown> => ({
    options: { baseURL: "https://acme.example/v1", modelsDiscovery: true, ...options },
  });

  test("env-ref apiKey with SET var sends Bearer", async () => {
    resetWarnedAuthEnvIds();
    const selection = selectAutoTargets(
      { acme: acmeProvider({ apiKey: "{ env: ACME_KEY }" }) },
      new Set(),
      { ACME_KEY: "top-secret-value" },
    );
    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0].apiKey).toBe("top-secret-value");
    const finish = stubFetch();
    const result = await pollProvider(selection.targets[0]);
    expect(result).toEqual([]);
    expect(finish().Authorization).toBe("Bearer top-secret-value");
  });

  test("env-ref apiKey with UNSET var: no auth header, warning once across cycles", async () => {
    resetWarnedAuthEnvIds();
    const environment: Record<string, string> = {};
    const first = selectAutoTargets(
      { acme: acmeProvider({ apiKey: "{ env: ACME_KEY }" }) },
      new Set(),
      environment,
    );
    expect(first.targets[0].apiKey).toBeUndefined();
    expect(first.messages).toContainEqual({
      level: "warn",
      message: 'Provider "acme": apiKey references unset env var "ACME_KEY"; polling without auth.',
    });
    const finish = stubFetch();
    await pollProvider(first.targets[0]);
    expect(finish().Authorization).toBeUndefined();

    const second = selectAutoTargets(
      { acme: acmeProvider({ apiKey: "{ env: ACME_KEY }" }) },
      new Set(),
      environment,
    );
    const repeats = second.messages.filter(
      (message) => message.level === "warn" && message.message.includes("ACME_KEY"),
    );
    expect(repeats).toHaveLength(0);
  });

  test("literal apiKey string sends Bearer", async () => {
    resetWarnedAuthEnvIds();
    const selection = selectAutoTargets(
      { acme: acmeProvider({ apiKey: "literal-key" }) },
      new Set(),
      {},
    );
    const finish = stubFetch();
    await pollProvider(selection.targets[0]);
    expect(finish().Authorization).toBe("Bearer literal-key");
  });

  test("apiKeyEnv resolving sends Bearer", async () => {
    resetWarnedAuthEnvIds();
    process.env.ACME_API_KEY_ENV = "env-sourced-secret";
    try {
      const selection = selectAutoTargets(
        { acme: acmeProvider({ apiKeyEnv: "ACME_API_KEY_ENV" }) },
        new Set(),
        {},
      );
      expect(selection.targets[0].apiKeyEnv).toBe("ACME_API_KEY_ENV");
      const finish = stubFetch();
      await pollProvider(selection.targets[0]);
      expect(finish().Authorization).toBe("Bearer env-sourced-secret");
    } finally {
      delete process.env.ACME_API_KEY_ENV;
    }
  });

  test("apiKeyEnv pointing at unset var: warning once + no header", async () => {
    resetWarnedAuthEnvIds();
    delete process.env.ACME_API_KEY_ENV;
    const selection = selectAutoTargets(
      { acme: acmeProvider({ apiKeyEnv: "ACME_API_KEY_ENV" }) },
      new Set(),
      {},
    );
    expect(selection.targets[0].apiKeyEnv).toBe("ACME_API_KEY_ENV");
    expect(selection.messages).toContainEqual({
      level: "warn",
      message:
        'Provider "acme": apiKeyEnv references unset env var "ACME_API_KEY_ENV"; polling without auth.',
    });
    const finish = stubFetch();
    await pollProvider(selection.targets[0]);
    expect(finish().Authorization).toBeUndefined();
  });
});

describe("credential store resolution", () => {
  /** Poll a target with stubbed fetch and return the captured request headers. */
  async function pollHeaders(target: ProviderTarget): Promise<Record<string, string | undefined>> {
    const finish = stubFetch();
    await pollProvider(target);
    return finish();
  }

  /** Mock integration store; records active/resolve calls for cache assertions. */
  function storeCtx(options: {
    active?: (id: string) => unknown;
    resolve?: (conn: unknown) => unknown;
  }): { ctx: any; activeCalls: string[]; resolveCalls: unknown[] } {
    const activeCalls: string[] = [];
    const resolveCalls: unknown[] = [];
    const ctx = {
      options: {},
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
      integration: {
        connection: {
          active: async (id: string) => {
            activeCalls.push(id);
            return options.active ? options.active(id) : undefined;
          },
          resolve: async (conn: unknown) => {
            resolveCalls.push(conn);
            return options.resolve ? options.resolve(conn) : undefined;
          },
        },
      },
    };
    return { ctx, activeCalls, resolveCalls };
  }

  const keyCredential = (key: string) => ({ type: "key", key });
  const credentialConnection = (id: string) => ({ type: "credential", id, label: id });
  const keyStoreCtx = (key: string) =>
    storeCtx({ active: credentialConnection, resolve: () => keyCredential(key) });
  const acmeTarget = (extra: ProviderTarget = {}): ProviderTarget => ({
    id: "acme",
    baseURL: "https://acme.example/v1",
    ...extra,
  });

  test("resolves a key credential and pollProvider sends Bearer", async () => {
    const { ctx } = keyStoreCtx("fake-store-key-0a1b2c3d");
    const secret = await createStoreAuthResolver(ctx)("acme");
    expect(secret).toBe("fake-store-key-0a1b2c3d");
    const headers = await pollHeaders(acmeTarget({ storeAuth: secret }));
    expect(headers.Authorization).toBe("Bearer fake-store-key-0a1b2c3d");
  });

  test("unknown provider id resolves to no store auth and no header", async () => {
    const { ctx } = storeCtx({ active: () => undefined });
    const resolver = createStoreAuthResolver(ctx);
    expect(await resolver("absent")).toBeUndefined();
    const headers = await pollHeaders({ id: "absent", baseURL: "https://absent.example/v1" });
    expect(headers.Authorization).toBeUndefined();
  });

  test("config apiKey wins over the store credential", async () => {
    const { ctx } = keyStoreCtx("fake-store-key-11111111");
    const headers = await pollHeaders(
      acmeTarget({ apiKey: "config-key", storeAuth: await createStoreAuthResolver(ctx)("acme") }),
    );
    expect(headers.Authorization).toBe("Bearer config-key");
  });

  test("apiKeyEnv environment value wins over apiKey and the store", async () => {
    process.env.ACME_STORE_ENV = "env-wins-secret";
    try {
      const { ctx } = keyStoreCtx("fake-store-key-22222222");
      const headers = await pollHeaders(
        acmeTarget({
          apiKeyEnv: "ACME_STORE_ENV",
          apiKey: "config-key",
          storeAuth: await createStoreAuthResolver(ctx)("acme"),
        }),
      );
      expect(headers.Authorization).toBe("Bearer env-wins-secret");
    } finally {
      delete process.env.ACME_STORE_ENV;
    }
  });

  test("oauth credential access token is sent as Bearer", async () => {
    const { ctx } = storeCtx({
      active: credentialConnection,
      resolve: () => ({
        type: "oauth",
        access: "fake-oauth-access-9999",
        refresh: "fake-refresh-token",
        expires: 1710000000,
      }),
    });
    const credential = await resolveIntegrationCredential(ctx, "acme");
    expect(credential).toEqual({ kind: "oauth", secret: "fake-oauth-access-9999" });
    const headers = await pollHeaders(acmeTarget({ storeAuth: credential?.secret }));
    expect(headers.Authorization).toBe("Bearer fake-oauth-access-9999");
  });

  test("absent or throwing integration falls through without auth or crash", async () => {
    const absent = createStoreAuthResolver({} as any);
    expect(await absent("acme")).toBeUndefined();

    const throwingActive = storeCtx({
      active: () => {
        throw new Error("store-unavailable");
      },
    });
    expect(await createStoreAuthResolver(throwingActive.ctx)("acme")).toBeUndefined();

    const throwingResolve = storeCtx({
      active: credentialConnection,
      resolve: () => {
        throw new Error("resolve-unavailable");
      },
    });
    expect(await createStoreAuthResolver(throwingResolve.ctx)("acme")).toBeUndefined();

    const headers = await pollHeaders({ id: "acme", baseURL: "https://acme.example/v1" });
    expect(headers.Authorization).toBeUndefined();
  });

  test("resolves each provider id once per cycle and again on the next cycle", async () => {
    const { ctx, activeCalls, resolveCalls } = storeCtx({
      active: (id) => (id === "acme" ? credentialConnection(id) : undefined),
      resolve: () => keyCredential("fake-store-key-44444444"),
    });
    const firstCycle = createStoreAuthResolver(ctx);
    expect(await firstCycle("acme")).toBe("fake-store-key-44444444");
    expect(await firstCycle("acme")).toBe("fake-store-key-44444444");
    expect(await firstCycle("missing")).toBeUndefined();
    expect(await firstCycle("missing")).toBeUndefined();
    expect(activeCalls).toEqual(["acme", "missing"]);

    const secondCycle = createStoreAuthResolver(ctx);
    expect(await secondCycle("acme")).toBe("fake-store-key-44444444");
    expect(activeCalls).toEqual(["acme", "missing", "acme"]);
    expect(resolveCalls).toHaveLength(2);
  });

  test("falls back to integrationID when the provider id is absent from the registry", async () => {
    const { ctx, activeCalls } = storeCtx({
      active: (id) => (id === "acme-real" ? credentialConnection(id) : undefined),
      resolve: () => keyCredential("fake-store-key-55555555"),
    });
    const credential = await resolveIntegrationCredential(ctx, "acme", "acme-real");
    expect(credential).toEqual({ kind: "key", secret: "fake-store-key-55555555" });
    expect(activeCalls).toEqual(["acme", "acme-real"]);
    const headers = await pollHeaders(
      acmeTarget({ integrationID: "acme-real", storeAuth: credential?.secret }),
    );
    expect(headers.Authorization).toBe("Bearer fake-store-key-55555555");
  });
});

describe("poll interval resolution", () => {
  test("per-provider beats options, options beat env, env beats default", () => {
    expect(resolveIntervalSeconds(30, 60, "120")).toBe(30);
    expect(resolveIntervalSeconds(undefined, 60, "120")).toBe(60);
    expect(resolveIntervalSeconds(undefined, undefined, "120")).toBe(120);
    expect(resolveIntervalSeconds(undefined, undefined, 120)).toBe(120);
    expect(resolveIntervalSeconds(undefined, undefined, undefined)).toBe(
      DEFAULT_POLL_INTERVAL_SECONDS,
    );
    expect(resolveIntervalSeconds()).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    resetWarnedIntervalKeys();
  });

  test("invalid values fall through to the next source or the default", () => {
    expect(resolveIntervalSeconds(NaN, 60, "120")).toBe(60);
    expect(resolveIntervalSeconds(Infinity, undefined, "120")).toBe(120);
    expect(resolveIntervalSeconds(5, undefined, undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolveIntervalSeconds("30", undefined, undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolveIntervalSeconds(undefined, NaN, undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolveIntervalSeconds(undefined, undefined, "5")).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolveIntervalSeconds(undefined, undefined, "abc")).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolveIntervalSeconds(undefined, undefined, "")).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    resetWarnedIntervalKeys();
  });

  test("invalid values warn once per source key", () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(resolveIntervalSeconds(5)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(resolveIntervalSeconds(5)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(resolveIntervalSeconds(undefined, 5)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(resolveIntervalSeconds(5)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("intervalSeconds=5");
      expect(warnings[1]).toContain("intervalSeconds=5");
    } finally {
      console.warn = previousWarn;
      resetWarnedIntervalKeys();
    }
  });

  test("boundaries: exactly the minimum is valid; below it is not", () => {
    expect(parseIntervalSeconds(MIN_POLL_INTERVAL_SECONDS)).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(parseIntervalSeconds(MIN_POLL_INTERVAL_SECONDS - 1)).toBeUndefined();
    expect(parseIntervalSeconds(-1)).toBeUndefined();
    expect(parseIntervalSeconds(Infinity)).toBeUndefined();
    expect(resolveIntervalSeconds(MIN_POLL_INTERVAL_SECONDS, undefined, undefined)).toBe(
      MIN_POLL_INTERVAL_SECONDS,
    );
    expect(resolveIntervalSeconds(-1, undefined, undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    resetWarnedIntervalKeys();
  });

  test("selectAutoTargets stores a valid per-provider interval and warns once on an invalid one", () => {
    const providers = {
      ok: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://ok.example/v1", modelsDiscovery: { enabled: true, intervalSeconds: 900 } },
      },
      bad: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://bad.example/v1", modelsDiscovery: { enabled: true, intervalSeconds: 5 } },
      },
    };
    const selection = selectAutoTargets(providers, new Set(), {});
    expect(selection.targets.find((t) => t.id === "ok")?.intervalSeconds).toBe(900);
    expect(selection.targets.find((t) => t.id === "bad")?.intervalSeconds).toBeUndefined();
    const badWarnings = selection.messages.filter(
      (m) => m.level === "warn" && m.message.includes('Provider "bad"') && m.message.includes("5"),
    );
    expect(badWarnings).toHaveLength(1);

    const second = selectAutoTargets(providers, new Set(), {});
    expect(
      second.messages.filter((m) => m.level === "warn" && m.message.includes('Provider "bad"')),
    ).toHaveLength(0);
    resetWarnedIntervalKeys();
  });
});

describe("rescan triggers", () => {
  test("computeDueTargets treats targets without a poll time as due", () => {
    const targets = [
      { id: "a", baseURL: "https://a.invalid/v1" },
      { id: "b", baseURL: "https://b.invalid/v1" },
    ];
    const due = computeDueTargets(targets, new Map(), 1_000_000);
    expect(due.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("computeDueTargets applies per-target intervals and the global fallback", () => {
    const now = 1_000_000;
    const lastPolled = new Map<string, number>([
      ["a", now - 4 * 60_000], // 4min ago, global 300s -> not due
      ["b", now - 6 * 60_000], // 6min ago, global 300s -> due
      ["c", now - 2 * 60_000], // per-target 60s -> due
      ["d", now - 60_000], // per-target 60s, exact boundary -> due
      ["e", now - 61_000], // per-target 60s -> due
    ]);
    const targets = [
      { id: "a", baseURL: "https://a.invalid/v1" },
      { id: "b", baseURL: "https://b.invalid/v1" },
      { id: "c", baseURL: "https://c.invalid/v1", intervalSeconds: 60 },
      { id: "d", baseURL: "https://d.invalid/v1", intervalSeconds: 60 },
      { id: "e", baseURL: "https://e.invalid/v1", intervalSeconds: 60 },
    ];
    const due = computeDueTargets(targets, lastPolled, now);
    expect(due.map((t) => t.id)).toEqual(["b", "c", "d", "e"]);
  });

  test("requestImmediateRefresh invokes the installed hook and tolerates a missing one", () => {
    let calls = 0;
    setImmediateRefreshHook(() => {
      calls += 1;
    });
    requestImmediateRefresh();
    requestImmediateRefresh();
    expect(calls).toBe(2);
    setImmediateRefreshHook(undefined);
    requestImmediateRefresh();
    expect(calls).toBe(2);
  });

  test("buildRefreshSummary separates successful polls (including empty) from failures", () => {
    const due = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const results = new Map<string, ModelEntry[] | undefined>([
      ["a", [{ id: "a1" }, { id: "a2" }]],
      ["b", []],
      ["c", undefined],
    ]);
    const summary = buildRefreshSummary(due, results);
    expect(summary.outcome).toBe("complete");
    expect(summary.polled).toBe(3);
    expect(summary.discoveredCounts).toEqual([
      ["a", 2],
      ["b", 0],
    ]);
    expect(summary.failed).toEqual(["c"]);
  });

  test("formatRescanAck renders counts, failures, and the error outcome", () => {
    expect(
      formatRescanAck({
        outcome: "complete",
        polled: 2,
        discoveredCounts: [
          ["a", 2],
          ["b", 0],
        ],
        failed: [],
      }),
    ).toBe("Models-discovery rescan complete: 2 model(s) across 2 provider(s).");
    expect(
      formatRescanAck({
        outcome: "complete",
        polled: 2,
        discoveredCounts: [["a", 3]],
        failed: ["b"],
      }),
    ).toBe("Models-discovery rescan complete: 3 model(s) across 1 provider(s). Failed, kept last known: b.");
    expect(formatRescanAck({ outcome: "error", polled: 0, discoveredCounts: [], failed: [] })).toBe(
      "Models-discovery rescan failed; previous models kept. Check server logs.",
    );
  });

  test("setup wires the immediate-refresh hook end to end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-wire-"));
    const configPath = path.join(dir, "explicit.json");
    fs.writeFileSync(configPath, "{}");
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
    process.env.OPENCODE_CONFIG = configPath;
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);

    const previousSetInterval = globalThis.setInterval;
    const intervals: Array<() => void> = [];
    (globalThis as any).setInterval = (cb: () => void): number => {
      intervals.push(cb);
      return intervals.length;
    };
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "wire-m" }] }), { status: 200 });
    };
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    };
    const context = {
      options: { providers: [{ id: "wire", baseURL: "https://wire.invalid/v1" }] },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBe(1);
      requestImmediateRefresh();
      await flush();
      expect(fetchCount).toBe(2);
      requestImmediateRefresh();
      await flush();
      expect(fetchCount).toBe(3);
      await cleanup?.();
      requestImmediateRefresh();
      await flush();
      expect(fetchCount).toBe(3);
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rescan command posts session acks for start and completion, headless stays silent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-ack-"));
    const configPath = path.join(dir, "explicit.json");
    fs.writeFileSync(configPath, "{}");
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
    process.env.OPENCODE_CONFIG = configPath;
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);

    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (cb: () => void): number => {
      return 1;
    };
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "ack-m" }] }), { status: 200 });
    };
    const acks: Array<{ sessionID: string; text: string; description?: string }> = [];
    let registered:
      | { name: string; execute: (context?: { sessionID?: string }) => Promise<void> | void }
      | undefined;
    const context = {
      options: { providers: [{ id: "ackw", baseURL: "https://ackw.invalid/v1" }] },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
      command: {
        transform: async (callback: (draft: { add(command: unknown): void }) => void) => {
          callback({
            add: (command: unknown) => {
              registered = command as {
                name: string;
                execute: (context?: { sessionID?: string }) => Promise<void> | void;
              };
            },
          });
          return { dispose: async () => {} };
        },
      },
      session: {
        synthetic: async (input: { sessionID: string; text: string; description?: string }) => {
          acks.push(input);
          return { id: "msg_ack_test" };
        },
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(registered?.name).toBe("models-discovery-rescan");
      expect(registered?.description).toBe("Rescan discovered models now");
      expect(acks.length).toBe(0);

      await registered!.execute({ sessionID: "ses_ack_test" });
      expect(acks.length).toBe(2);
      // Acks carry a trailing ISO timestamp; assert the text prefix and shape.
      expect(acks[0].sessionID).toBe("ses_ack_test");
      expect(acks[0].description).toBe("models-discovery-rescan");
      expect(acks[0].text).toMatch(
        /^Models-discovery rescan started\. \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]$/,
      );
      expect(acks[1].description).toBe("models-discovery-rescan");
      expect(acks[1].text).toMatch(
        /^Models-discovery rescan complete: 1 model\(s\) across 1 provider\(s\)\. \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]$/,
      );

      // Headless invocation (no sessionID) still refreshes but posts no acks.
      const fetchBefore = fetchCount;
      await registered!.execute({});
      expect(fetchCount).toBeGreaterThan(fetchBefore);
      expect(acks.length).toBe(2);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config watch debounces a burst into a single trigger", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-watch-"));
    const configPath = path.join(dir, "opencode.json");
    fs.writeFileSync(configPath, "{}");
    let triggers = 0;
    const handle = createConfigWatch(
      [configPath],
      () => {
        triggers += 1;
      },
      40,
    );
    try {
      fs.writeFileSync(configPath, "{}");
      fs.writeFileSync(configPath, "{}");
      fs.writeFileSync(configPath, "{}");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(triggers).toBe(1);
      fs.writeFileSync(configPath, "{}");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(triggers).toBe(2);
    } finally {
      handle.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config watch skips nonexistent files and non-file sources", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-watchskip-"));
    const existing = path.join(dir, "opencode.json");
    const missing = path.join(dir, "missing.json");
    fs.writeFileSync(existing, "{}");
    const sources = resolveConfigSources({
      opencodeConfig: existing,
      opencodeConfigContent: '{"provider":{}}',
      home: dir,
      cwd: dir,
    });
    const filePaths = sources
      .filter((source) => source.kind === "file" && typeof source.path === "string")
      .map((source) => source.path as string);
    expect(filePaths).toContain(existing);
    // The inline content source must exist but never become a watch path.
    expect(sources.some((source) => source.kind === "content")).toBe(true);
    expect(filePaths.every((p) => p !== "inline")).toBe(true);
    let triggers = 0;
    const handle = createConfigWatch(
      [...filePaths, missing],
      () => {
        triggers += 1;
      },
      40,
    );
    try {
      fs.writeFileSync(missing, "{}");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(triggers).toBe(0);
      fs.writeFileSync(existing, "{}");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(triggers).toBe(1);
    } finally {
      handle.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cacheFor success TTL", () => {
  test("precedence chain: per-provider > options > env > unset (feature off)", () => {
    expect(resolveCacheForSeconds(86400, 3600, "60")).toBe(86400);
    expect(resolveCacheForSeconds(undefined, 3600, "60")).toBe(3600);
    expect(resolveCacheForSeconds(undefined, undefined, "60")).toBe(60);
    expect(resolveCacheForSeconds(undefined, undefined, 86400)).toBe(86400);
    expect(resolveCacheForSeconds(undefined, undefined, undefined)).toBeUndefined();
    expect(resolveCacheForSeconds()).toBeUndefined();
    resetWarnedCacheForKeys();
  });

  test("unset cacheFor keeps today's interval-only due behavior", () => {
    const now = 1_000_000;
    const targets = [{ id: "a", baseURL: "https://a.invalid/v1" }];
    // Interval elapsed but a fresh successful poll exists: without a TTL the
    // success timestamp is irrelevant and the target stays due.
    const due = computeDueTargets(
      targets,
      new Map([["a", now - 400_000]]),
      now,
      DEFAULT_POLL_INTERVAL_SECONDS,
      new Map([["a", now - 1_000]]),
    );
    expect(due.map((t) => t.id)).toEqual(["a"]);
  });

  test("within-TTL skip, TTL-expired poll, and the interval gate still apply", () => {
    const now = 1_000_000;
    const targets = [
      { id: "fresh", baseURL: "https://a.invalid/v1" },
      { id: "stale", baseURL: "https://b.invalid/v1" },
      { id: "interval-bound", baseURL: "https://c.invalid/v1" },
    ];
    const lastPolled = new Map<string, number>([
      ["fresh", now - 400_000], // interval elapsed
      ["stale", now - 400_000], // interval elapsed
      ["interval-bound", now - 60_000], // interval NOT elapsed (300s global)
    ]);
    const lastSuccess = new Map<string, number>([
      ["fresh", now - 30_000], // TTL (60s) not stale -> skip
      ["stale", now - 120_000], // TTL stale -> poll
      ["interval-bound", now - 120_000], // TTL stale but the interval gate holds
    ]);
    const due = computeDueTargets(targets, lastPolled, now, 300, lastSuccess, 60);
    expect(due.map((t) => t.id)).toEqual(["stale"]);
  });

  test("failed polls do not start the TTL: the next interval retry stays eligible", () => {
    const now = 1_000_000;
    const targets = [
      { id: "retry", baseURL: "https://a.invalid/v1" },
      { id: "never", baseURL: "https://b.invalid/v1" },
    ];
    // lastPolled marks the failed attempt; lastSuccess holds the older win.
    const due = computeDueTargets(
      targets,
      new Map([
        ["retry", now - 300_000],
        ["never", now - 300_000],
      ]),
      now,
      300,
      new Map([["retry", now - 400_000]]),
      60,
    );
    expect(due.map((t) => t.id)).toEqual(["retry", "never"]);
  });

  test("per-target cacheFor beats the global; watch mode skips the interval but keeps the TTL", () => {
    const now = 1_000_000;
    const targets = [
      { id: "per-target", baseURL: "https://a.invalid/v1", cacheForSeconds: 60 },
      { id: "no-ttl", baseURL: "https://b.invalid/v1" },
      { id: "global-stale", baseURL: "https://c.invalid/v1" },
    ];
    const lastSuccess = new Map<string, number>([
      ["per-target", now - 30_000], // per-target TTL fresh -> skipped even in watch mode
      ["global-stale", now - 120_000], // global TTL stale -> polled
    ]);
    const due = computeDueTargets(targets, new Map(), now, 300, lastSuccess, 60, true);
    expect(due.map((t) => t.id)).toEqual(["no-ttl", "global-stale"]);
  });

  test("invalid values are ignored and below-min values clamp; 86400 is accepted", () => {
    expect(parseCacheForSeconds(86400)).toBe(86400);
    expect(parseCacheForSeconds(MIN_CACHE_FOR_SECONDS)).toBe(MIN_CACHE_FOR_SECONDS);
    expect(parseCacheForSeconds(MIN_CACHE_FOR_SECONDS - 1)).toBe(MIN_CACHE_FOR_SECONDS);
    expect(parseCacheForSeconds(0)).toBeUndefined();
    expect(parseCacheForSeconds(-1)).toBeUndefined();
    expect(parseCacheForSeconds(NaN)).toBeUndefined();
    expect(parseCacheForSeconds(Infinity)).toBeUndefined();
    expect(parseCacheForSeconds("86400")).toBeUndefined();

    expect(resolveCacheForSeconds("30")).toBeUndefined();
    expect(resolveCacheForSeconds(5)).toBe(60);
    expect(resolveCacheForSeconds(undefined, "abc")).toBeUndefined();
    expect(resolveCacheForSeconds(undefined, undefined, "abc")).toBeUndefined();
    expect(resolveCacheForSeconds(undefined, undefined, "5")).toBe(60);
    expect(resolveCacheForSeconds(undefined, undefined, "")).toBeUndefined();
    expect(resolveCacheForSeconds(86400, 3600, "60")).toBe(86400);
    expect(resolveCacheForSeconds(undefined, 86400, undefined)).toBe(86400);
    expect(resolveCacheForSeconds(undefined, undefined, "86400")).toBe(86400);
    resetWarnedCacheForKeys();
  });

  test("invalid and clamped values warn once per source", () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(resolveCacheForSeconds(5)).toBe(60);
      expect(resolveCacheForSeconds(5)).toBe(60);
      expect(resolveCacheForSeconds("30")).toBeUndefined();
      expect(resolveCacheForSeconds("30")).toBeUndefined();
      expect(resolveCacheForSeconds(undefined, "abc")).toBeUndefined();
      expect(resolveCacheForSeconds(undefined, undefined, "abc")).toBeUndefined();
      expect(resolveCacheForSeconds(undefined, undefined, "5")).toBe(60);
      expect(resolveCacheForSeconds(undefined, undefined, "")).toBeUndefined();
      // One warning per source: provider (clamp), options (invalid), env
      // (invalid; the later env clamp/empty calls reuse the same key).
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain("cacheFor=5");
      expect(warnings[0]).toContain("below min");
      expect(warnings[1]).toContain("options cacheFor=abc");
      expect(warnings[1]).toContain("is invalid");
      expect(warnings[2]).toContain("OPENCODE_MODELS_DISCOVERY_CACHE_FOR_SECONDS");
      expect(warnings[2]).toContain("cacheFor=abc");
    } finally {
      console.warn = previousWarn;
      resetWarnedCacheForKeys();
    }
  });

  test("selectAutoTargets stores valid and clamped per-provider cacheFor and warns once on invalid", () => {
    const providers = {
      ok: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://ok.example/v1",
          modelsDiscovery: { enabled: true, cacheFor: 86400 },
        },
      },
      clamped: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://clamped.example/v1",
          modelsDiscovery: { enabled: true, cacheFor: 5 },
        },
      },
      bad: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://bad.example/v1",
          modelsDiscovery: { enabled: true, cacheFor: "soon" },
        },
      },
    };
    const selection = selectAutoTargets(providers, new Set(), {});
    expect(selection.targets.find((t) => t.id === "ok")?.cacheForSeconds).toBe(86400);
    expect(selection.targets.find((t) => t.id === "clamped")?.cacheForSeconds).toBe(60);
    expect(selection.targets.find((t) => t.id === "bad")?.cacheForSeconds).toBeUndefined();
    const clampedWarnings = selection.messages.filter(
      (m) =>
        m.level === "warn" &&
        m.message.includes('Provider "clamped"') &&
        m.message.includes("below min"),
    );
    expect(clampedWarnings).toHaveLength(1);
    const invalidWarnings = selection.messages.filter(
      (m) =>
        m.level === "warn" &&
        m.message.includes('Provider "bad"') &&
        m.message.includes("is invalid"),
    );
    expect(invalidWarnings).toHaveLength(1);

    const second = selectAutoTargets(providers, new Set(), {});
    expect(
      second.messages.filter(
        (m) =>
          m.level === "warn" &&
          (m.message.includes('Provider "clamped"') || m.message.includes('Provider "bad"')),
      ),
    ).toHaveLength(0);
    resetWarnedCacheForKeys();
  });

  test("config-watch refresh respects the TTL while the rescan command forces past it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-ttl-"));
    const configPath = path.join(dir, "explicit.json");
    fs.writeFileSync(configPath, "{}");
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
    process.env.OPENCODE_CONFIG = configPath;
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);

    const previousSetInterval = globalThis.setInterval;
    const intervals: Array<() => void> = [];
    (globalThis as any).setInterval = (cb: () => void): number => {
      intervals.push(cb);
      return intervals.length;
    };
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    };
    const waitWatch = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await flush();
    };
    const context = {
      options: { providers: [{ id: "ttl", baseURL: "https://ttl.invalid/v1" }], cacheFor: 60 },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBe(1);
      // The successful initial poll started the 60s TTL; config edits within
      // the TTL refresh nothing (no network poll, no catalog churn).
      fs.writeFileSync(configPath, "{}");
      await waitWatch();
      expect(fetchCount).toBe(1);
      fs.writeFileSync(configPath, "{}");
      await waitWatch();
      expect(fetchCount).toBe(1);
      // The rescan command is the documented escape: it forces past the TTL.
      requestImmediateRefresh();
      await flush();
      expect(fetchCount).toBe(2);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed poll does not start the TTL: the next config-watch refresh polls again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-ttlfail-"));
    const configPath = path.join(dir, "explicit.json");
    fs.writeFileSync(configPath, "{}");
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
    process.env.OPENCODE_CONFIG = configPath;
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);

    const previousSetInterval = globalThis.setInterval;
    const intervals: Array<() => void> = [];
    (globalThis as any).setInterval = (cb: () => void): number => {
      intervals.push(cb);
      return intervals.length;
    };
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    };
    const waitWatch = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await flush();
    };
    const context = {
      options: { providers: [{ id: "ttl", baseURL: "https://ttl.invalid/v1" }], cacheFor: 60 },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBe(1);
      // Initial poll failed: no last success exists, so the watch-triggered
      // refresh polls again instead of sitting inside a TTL.
      fs.writeFileSync(configPath, "{}");
      await waitWatch();
      expect(fetchCount).toBe(2);
      // That poll succeeded with an EMPTY list and started the TTL, so the
      // next config edit is skipped again.
      fs.writeFileSync(configPath, "{}");
      await waitWatch();
      expect(fetchCount).toBe(2);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state file persistence", () => {
  /**
   * Env/cwd isolation for setup() tests; mirrors the inline pattern used by
   * the rescan-trigger tests above. Does not touch STATE_FILE_ENV — the
   * module-level beforeEach pins that per test.
   */
  function isolateConfigEnv(dir: string): () => void {
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
    const configPath = path.join(dir, "explicit.json");
    fs.writeFileSync(configPath, "{}");
    process.env.OPENCODE_CONFIG = configPath;
    process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    process.env.HOME = path.join(dir, "home");
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.chdir(dir);
    return restore;
  }

  test("resolveStateFilePath uses XDG_STATE_HOME and defaults under home", () => {
    const homeDefault = path.join(os.homedir(), ".local", "state", "opencode", "model-discovery", "state.json");
    expect(resolveStateFilePath({})).toBe(homeDefault);
    expect(resolveStateFilePath({ XDG_STATE_HOME: "/tmp/xdg-state" })).toBe(
      "/tmp/xdg-state/opencode/model-discovery/state.json",
    );
    // Empty string is treated as unset.
    expect(resolveStateFilePath({ XDG_STATE_HOME: "" })).toBe(homeDefault);
  });

  test("OPENCODE_MODELS_DISCOVERY_STATE_FILE overrides XDG_STATE_HOME", () => {
    expect(
      resolveStateFilePath({
        [STATE_FILE_ENV]: "/tmp/override/state.json",
        XDG_STATE_HOME: "/tmp/xdg",
      }),
    ).toBe("/tmp/override/state.json");
    // A relative override resolves against the process cwd.
    const relative = resolveStateFilePath({ [STATE_FILE_ENV]: "rel/state.json" });
    expect(path.isAbsolute(relative)).toBe(true);
    expect(relative).toBe(path.resolve("rel/state.json"));
  });

  test("loadStateFile ignores corrupt JSON and unsupported shapes without throwing", () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      fs.writeFileSync(isolatedStatePath, "not json {{");
      expect(loadStateFile(isolatedStatePath)).toBeNull();
      fs.writeFileSync(isolatedStatePath, '{"version":2,"providers":{}}');
      expect(loadStateFile(isolatedStatePath)).toBeNull();
      fs.writeFileSync(isolatedStatePath, "null");
      expect(loadStateFile(isolatedStatePath)).toBeNull();
      fs.writeFileSync(isolatedStatePath, "[]");
      expect(loadStateFile(isolatedStatePath)).toBeNull();
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        // Sanitized: the warn names the reason, never the raw parse error.
        expect(warning).toContain("state-file ignored");
        expect(warning).not.toContain("not json");
        expect(warning).not.toContain("Unexpected");
      }
    } finally {
      console.warn = previousWarn;
    }
  });

  test("loadStateFile keeps valid entries and skips invalid ones", () => {
    const file = {
      version: 1,
      providers: {
        good: {
          lastSuccessAt: "2026-09-01T00:00:00.000Z",
          lastPolledAt: "2026-09-01T00:00:01.000Z",
          modelCount: 4,
          cacheForSeconds: null,
          lastTrigger: "poll",
        },
        badDate: {
          lastSuccessAt: "not-a-date",
          lastPolledAt: "2026-09-01T00:00:01.000Z",
          modelCount: 1,
          cacheForSeconds: null,
          lastTrigger: "poll",
        },
        badCount: {
          lastSuccessAt: "2026-09-01T00:00:00.000Z",
          lastPolledAt: "2026-09-01T00:00:01.000Z",
          modelCount: -3,
          cacheForSeconds: null,
          lastTrigger: "poll",
        },
        badTrigger: {
          lastSuccessAt: "2026-09-01T00:00:00.000Z",
          lastPolledAt: "2026-09-01T00:00:01.000Z",
          modelCount: 1,
          cacheForSeconds: null,
          lastTrigger: "cron",
        },
      },
    };
    fs.writeFileSync(isolatedStatePath, JSON.stringify(file));
    const state = loadStateFile(isolatedStatePath);
    expect(state).not.toBeNull();
    expect(Object.keys(state!.providers)).toEqual(["good"]);
  });

  test("a failed poll never writes lastSuccessAt and state file preserves the clock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-statefail-"));
    const restore = isolateConfigEnv(dir);
    const oldMs = Date.now() - 3_600_000;
    writeStateFile(
      isolatedStatePath,
      buildStateFile(
        new Map([
          [
            "p1",
            { lastSuccessMs: oldMs, lastPolledMs: oldMs, modelCount: 3, cacheForSeconds: null, lastTrigger: "poll" },
          ],
        ]),
      ),
    );
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: [{ id: "p1-m1" }, { id: "p1-m2" }] }), { status: 200 });
    };
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    };
    const context = {
      options: { providers: [{ id: "p1", baseURL: "https://p1.invalid/v1" }] },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBe(1);
      // The failed cycle rewrote lastPolledAt but kept the seeded success
      // clock and model count: failures never clobber lastSuccessAt.
      let onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(onDisk.providers.p1.lastSuccessAt).toBe(new Date(oldMs).toISOString());
      expect(onDisk.providers.p1.modelCount).toBe(3);

      requestImmediateRefresh();
      await flush();
      expect(fetchCount).toBe(2);
      onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(new Date(onDisk.providers.p1.lastSuccessAt).getTime()).toBeGreaterThan(oldMs);
      expect(onDisk.providers.p1.modelCount).toBe(2);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart seeding honors the cache TTL (fresh success = no poll on setup)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-seedttl-"));
    const restore = isolateConfigEnv(dir);
    const now = Date.now();
    writeStateFile(
      isolatedStatePath,
      buildStateFile(
        new Map([
          [
            "p1",
            {
              // Interval long elapsed, but the success clock is fresh: the
              // seeded TTL (not the interval) is what must skip this poll.
              lastSuccessMs: now - 10_000,
              lastPolledMs: now - 400_000,
              modelCount: 2,
              cacheForSeconds: 86400,
              lastTrigger: "poll",
            },
          ],
        ]),
      ),
    );
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const context = {
      options: { providers: [{ id: "p1", baseURL: "https://p1.invalid/v1" }], cacheFor: 86400 },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBe(0);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart seeding repolls when the TTL expired", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-seedexp-"));
    const restore = isolateConfigEnv(dir);
    const staleMs = Date.now() - 100_000 * 1000; // ~27.8h, beyond cacheFor 86400
    writeStateFile(
      isolatedStatePath,
      buildStateFile(
        new Map([
          [
            "p1",
            {
              lastSuccessMs: staleMs,
              lastPolledMs: staleMs,
              modelCount: 2,
              cacheForSeconds: 86400,
              lastTrigger: "poll",
            },
          ],
        ]),
      ),
    );
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "seed-m" }] }), { status: 200 });
    };
    const context = {
      options: { providers: [{ id: "p1", baseURL: "https://p1.invalid/v1" }], cacheFor: 86400 },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      expect(fetchCount).toBeGreaterThanOrEqual(1);
      // The expired seed was replaced by a fresh success clock on disk.
      const onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(new Date(onDisk.providers.p1.lastSuccessAt).getTime()).toBeGreaterThan(staleMs);
      expect(onDisk.providers.p1.lastTrigger).toBe("poll");
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state file after a successful cycle has ISO shape and perms", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-shape-"));
    const restore = isolateConfigEnv(dir);
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
    const context = {
      options: { providers: [{ id: "p1", baseURL: "https://p1.invalid/v1" }] },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      const onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(onDisk.version).toBe(1);
      expect(onDisk.providers.p1.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(onDisk.providers.p1.lastPolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(onDisk.providers.p1.modelCount).toBe(2);
      expect(onDisk.providers.p1.cacheForSeconds).toBeNull();
      expect(onDisk.providers.p1.lastTrigger).toBe("poll");
      expect(onDisk.lastRescanAt).toBeUndefined();
      // 0600 on the file; the state dir is 0700.
      expect(fs.statSync(isolatedStatePath).mode & 0o777).toBe(0o600);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rescan command stamps lastTrigger command and lastRescanAt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-staterescan-"));
    const restore = isolateConfigEnv(dir);
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "state-m" }] }), { status: 200 });
    let registered:
      | { name: string; execute: (context?: { sessionID?: string }) => Promise<void> | void }
      | undefined;
    const context = {
      options: { providers: [{ id: "cmdstate", baseURL: "https://cmdstate.invalid/v1" }] },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
      command: {
        transform: async (callback: (draft: { add(command: unknown): void }) => void) => {
          callback({
            add: (command: unknown) => {
              registered = command as {
                name: string;
                execute: (context?: { sessionID?: string }) => Promise<void> | void;
              };
            },
          });
          return { dispose: async () => {} };
        },
      },
      session: {
        synthetic: async (input: { sessionID: string; text: string; description?: string }) => {
          return { id: "msg_state_test" };
        },
      },
    } as any;
    try {
      const cleanup = await setup(context);
      // The initial cycle wrote poll-triggered state first.
      let onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(onDisk.providers.cmdstate.modelCount).toBe(1);
      expect(onDisk.providers.cmdstate.lastTrigger).toBe("poll");
      expect(onDisk.lastRescanAt).toBeUndefined();

      await registered!.execute({ sessionID: "ses_state_test" });
      onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(registered?.name).toBe("models-discovery-rescan");
      expect(onDisk.providers.cmdstate.modelCount).toBe(1);
      expect(onDisk.providers.cmdstate.lastTrigger).toBe("command");
      expect(onDisk.lastRescanAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mixed cycle keeps TTL-skipped providers on disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-mixed-"));
    const restore = isolateConfigEnv(dir);
    const now = Date.now();
    const cachedSuccessIso = new Date(now - 10_000).toISOString();
    writeStateFile(
      isolatedStatePath,
      buildStateFile(
        new Map([
          [
            "cached",
            {
              // Well inside the TTL: this provider must NOT be polled, and
              // its seeded clocks/counts must survive the cycle's snapshot.
              lastSuccessMs: now - 10_000,
              lastPolledMs: now - 400_000,
              modelCount: 3,
              cacheForSeconds: 86400,
              lastTrigger: "poll",
            },
          ],
        ]),
      ),
    );
    const previousSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (): number => 1;
    const previousFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = async (url: unknown) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "fresh-m1" }, { id: "fresh-m2" }] }), { status: 200 });
    };
    const context = {
      options: {
        providers: [
          { id: "cached", baseURL: "https://cached.invalid/v1" },
          { id: "fresh", baseURL: "https://fresh.invalid/v1" },
        ],
        cacheFor: 86400,
      },
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
    } as any;
    try {
      const cleanup = await setup(context);
      // Only "fresh" was polled; "cached" sat inside its seeded TTL.
      expect(fetched.length).toBe(1);
      expect(fetched.some((url) => url.includes("cached.invalid"))).toBe(false);
      // The snapshot merges BOTH providers: the TTL-skipped one keeps its
      // seeded clock, trigger, and count untouched.
      const onDisk = JSON.parse(fs.readFileSync(isolatedStatePath, "utf8"));
      expect(Object.keys(onDisk.providers).sort()).toEqual(["cached", "fresh"]);
      expect(onDisk.providers.cached.lastSuccessAt).toBe(cachedSuccessIso);
      expect(onDisk.providers.cached.lastTrigger).toBe("poll");
      expect(onDisk.providers.cached.modelCount).toBe(3);
      expect(onDisk.providers.fresh.modelCount).toBe(2);
      await cleanup?.();
    } finally {
      restore();
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("poll timeout", () => {
  test("default timeout raised to 20s with an integer floor", () => {
    expect(POLL_TIMEOUT_MS).toBe(20000);
    expect(MIN_POLL_TIMEOUT_SECONDS).toBe(5);
    expect(parsePollTimeoutSeconds(5)).toBe(5);
    expect(parsePollTimeoutSeconds(30)).toBe(30);
    expect(parsePollTimeoutSeconds(4)).toBe(5);
    expect(parsePollTimeoutSeconds(4.5)).toBeUndefined();
    expect(parsePollTimeoutSeconds(0)).toBeUndefined();
    expect(parsePollTimeoutSeconds(-1)).toBeUndefined();
    expect(parsePollTimeoutSeconds("30")).toBeUndefined();
    expect(parsePollTimeoutSeconds(NaN)).toBeUndefined();
    expect(parsePollTimeoutSeconds(Infinity)).toBeUndefined();
  });

  test("poll timeout precedence: per-provider > options > env > default", () => {
    expect(resolvePollTimeoutSeconds(30, 60, "120")).toBe(30);
    expect(resolvePollTimeoutSeconds(undefined, 60, "120")).toBe(60);
    expect(resolvePollTimeoutSeconds(undefined, undefined, "120")).toBe(120);
    expect(resolvePollTimeoutSeconds(undefined, undefined, undefined)).toBe(POLL_TIMEOUT_MS / 1000);
    expect(resolvePollTimeoutSeconds()).toBe(POLL_TIMEOUT_MS / 1000);
    resetWarnedPollTimeoutKeys();
  });

  test("invalid poll timeouts fall through and below-min values clamp with a warning", () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(resolvePollTimeoutSeconds(4)).toBe(MIN_POLL_TIMEOUT_SECONDS);
      expect(resolvePollTimeoutSeconds(4)).toBe(MIN_POLL_TIMEOUT_SECONDS);
      // Warn-once: the second identical call adds no new warning.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("pollTimeoutSeconds=4");
      expect(warnings[0]).toContain("below min");
      // Non-integer values are invalid, not clamped: fall through to default.
      expect(resolvePollTimeoutSeconds(3.5)).toBe(POLL_TIMEOUT_MS / 1000);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = previousWarn;
      resetWarnedPollTimeoutKeys();
    }
  });

  test("selectAutoTargets stores per-provider pollTimeoutMs and warns once on invalid", () => {
    const providers = {
      ok: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://ok.example/v1",
          modelsDiscovery: { enabled: true, pollTimeoutSeconds: 30 },
        },
      },
      clamped: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://clamped.example/v1",
          modelsDiscovery: { enabled: true, pollTimeoutSeconds: 3 },
        },
      },
      bad: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://bad.example/v1",
          modelsDiscovery: { enabled: true, pollTimeoutSeconds: "slow" },
        },
      },
    };
    const selection = selectAutoTargets(providers, new Set(), {});
    expect(selection.targets.find((t) => t.id === "ok")?.pollTimeoutMs).toBe(30000);
    expect(selection.targets.find((t) => t.id === "clamped")?.pollTimeoutMs).toBe(5000);
    expect(selection.targets.find((t) => t.id === "bad")?.pollTimeoutMs).toBeUndefined();
    const clampedWarnings = selection.messages.filter(
      (m) =>
        m.level === "warn" &&
        m.message.includes('Provider "clamped"') &&
        m.message.includes("below min"),
    );
    expect(clampedWarnings).toHaveLength(1);
    const invalidWarnings = selection.messages.filter(
      (m) =>
        m.level === "warn" &&
        m.message.includes('Provider "bad"') &&
        m.message.includes("is invalid"),
    );
    expect(invalidWarnings).toHaveLength(1);

    const second = selectAutoTargets(providers, new Set(), {});
    expect(
      second.messages.filter(
        (m) =>
          m.level === "warn" &&
          (m.message.includes('Provider "clamped"') || m.message.includes('Provider "bad"')),
      ),
    ).toHaveLength(0);
    resetWarnedPollTimeoutKeys();
  });

  test("pollProvider uses the per-target timeout and aborts on slow responses", async () => {
    const previousFetch = globalThis.fetch;
    let capturedSignal: unknown;
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal;
      const signal = init?.signal;
      if (signal instanceof AbortSignal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      throw abort;
    };
    try {
      const started = Date.now();
      const result = await pollProvider({
        id: "slow",
        baseURL: "https://slow.invalid/v1",
        pollTimeoutMs: 50,
      });
      expect(result).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(4000);
      expect(capturedSignal instanceof AbortSignal).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("pollProvider fallback timeout applies when target has none", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal instanceof AbortSignal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      throw abort;
    };
    try {
      const started = Date.now();
      const result = await pollProvider({ id: "slow-fallback", baseURL: "https://slow.invalid/v1" }, 50);
      expect(result).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("parameters path enrichment", () => {
  interface RouteConfig {
    models: () => Response;
    parameters?: (model: string) => Response;
  }

  /** Route-based fetch stub, mirroring stubFetch: replaces globalThis.fetch; restore() puts it back. */
  function installFetch(config: RouteConfig): { calls: string[]; restore: () => void } {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (rawUrl: unknown, _init?: RequestInit) => {
      const url = new URL(String(rawUrl));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/models/parameters") {
        const model = url.searchParams.get("model") ?? "";
        return config.parameters ? config.parameters(model) : new Response("{}", { status: 404 });
      }
      if (url.pathname.endsWith("/models")) return config.models();
      return new Response("not found", { status: 404 });
    };
    return {
      calls,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  const modelsBody = (data: unknown[]): Response =>
    new Response(JSON.stringify({ data }), { status: 200 });
  const paramsBody = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  const paramsTarget = (extra: Record<string, unknown> = {}): any => ({
    id: "p",
    baseURL: "https://p.invalid/v1",
    enrich: true,
    parametersPath: "/api/models/parameters",
    ...extra,
  });

  test("parameters levels become variants for models lacking them", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () =>
        modelsBody([{ id: "m1", capabilities: { tools: false, input: ["text"], output: ["text"] } }]),
      parameters: () => paramsBody({ reasoning_effort_levels: ["low", "high"], supports_reasoning: true }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "pa" }));
      expect(result).toHaveLength(1);
      expect(result?.[0]?.metadata).toEqual({
        capabilities: { tools: false, input: ["text"], output: ["text"] },
        variants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          { id: "high", settings: { reasoningEffort: "high" } },
        ],
      });
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("supports_reasoning without levels adds no variants", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () => paramsBody({ supports_reasoning: true }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "pb" }));
      expect(result?.[0]?.metadata?.variants).toBeUndefined();
      expect("variants" in (result?.[0]?.metadata ?? {})).toBe(false);
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("404 parameters response skips the model and warns once per provider", async () => {
    resetWarnedParametersKeys();
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () => new Response(JSON.stringify({ error: "unknown model" }), { status: 404 }),
    });
    try {
      const first = await pollProvider(paramsTarget({ id: "pc" }));
      expect(first?.[0]?.metadata?.variants).toBeUndefined();
      const second = await pollProvider(paramsTarget({ id: "pc" }));
      expect(second?.[0]?.metadata?.variants).toBeUndefined();
      // Warn-once per provider id across cycles...
      expect(warnings.filter((w) => w.includes('Provider "pc"'))).toHaveLength(1);
      expect(warnings.every((w) => w.includes("parameters fetch failed"))).toBe(true);
      // ...but 404s are not cached: the parameters endpoint is retried next cycle.
      expect(finish.calls.filter((c) => c.startsWith("/api/models/parameters"))).toHaveLength(2);
    } finally {
      console.warn = previousWarn;
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("absent parametersPath performs zero parameters fetches", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({ models: () => modelsBody([{ id: "m1" }]) });
    try {
      const result = await pollProvider(paramsTarget({ id: "pd", parametersPath: undefined }));
      expect(result).toHaveLength(1);
      expect(finish.calls).toEqual(["/v1/models"]);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("parameters cache: TTL honors the context, bypass refetches", async () => {
    resetWarnedParametersKeys();
    let parameterFetches = 0;
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () => {
        parameterFetches += 1;
        return paramsBody({ reasoning_effort_levels: ["low"] });
      },
    });
    try {
      const pe = paramsTarget({ id: "pe" });
      await pollProvider(pe, undefined, { cacheForSeconds: 60 });
      await pollProvider(pe, undefined, { cacheForSeconds: 60 });
      expect(parameterFetches).toBe(1);
      await pollProvider(pe, undefined, { bypassParameterCache: true });
      expect(parameterFetches).toBe(2);
      await pollProvider(pe, undefined, { cacheForSeconds: 0 });
      expect(parameterFetches).toBe(3);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("parameters variants join per-field enrichment, provider wins", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () =>
        modelsBody([{ id: "m1", capabilities: { tools: false, input: ["text"], output: ["text"] } }]),
      parameters: () => paramsBody({ reasoning_effort_levels: ["low", "high"] }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "pf" }));
      const providerRich = result?.[0]?.metadata;
      expect(providerRich?.variants).toEqual([
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ]);
      const candidates = buildCatalogJoin([
        catalogRecord(
          "builtin-pf",
          {
            m1: catalogModel("Join M1", {
              variants: [{ id: "join-max", settings: { reasoningEffort: "max" } }],
              limit: { context: 555, output: 5 },
            }),
          },
          "enabled",
        ),
      ]);
      const resolution = resolveModelMetadata("pf", "m1", providerRich, candidates);
      expect(resolution.provenance).toBe("mixed");
      // Provider (parameters) variants win the variants field...
      expect(resolution.metadata?.variants).toEqual([
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ]);
      // ...while the join fills the field the provider lacked.
      expect(resolution.metadata?.limit).toEqual({ context: 555, output: 5 });
      expect(resolution.metadata?.capabilities).toEqual({
        tools: false,
        input: ["text"],
        output: ["text"],
      });
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("one parameters fetch backfills variants, limit, and capabilities", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () =>
        paramsBody({
          reasoning_effort_levels: ["low"],
          max_tokens: 200000,
          max_input_tokens: 190000,
          max_output_tokens: 8192,
          supported_modalities: ["text", "image"],
          supports_function_calling: true,
        }),
    });
    try {
      const expected = {
        variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
        limit: { context: 200000, input: 190000, output: 8192 },
        capabilities: { tools: true, input: ["text", "image"], output: ["text", "image"] },
      };
      const first = await pollProvider(paramsTarget({ id: "pg" }));
      expect(first?.[0]?.metadata).toEqual(expected);
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
      // The second poll serves all three fields from the cached fetch:
      // only the main poll is repeated, the parameters fetch is not.
      const second = await pollProvider(paramsTarget({ id: "pg" }));
      expect(second?.[0]?.metadata).toEqual(expected);
      expect(finish.calls.filter((c) => c.startsWith("/api/models/parameters"))).toHaveLength(1);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("parameters limit omits input when max_input_tokens is absent", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () =>
        paramsBody({ max_tokens: 1000, max_output_tokens: 50, supported_modalities: ["text", "image"] }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "ph" }));
      expect(result?.[0]?.metadata?.limit).toEqual({ context: 1000, output: 50 });
      // Output modalities reuse the input list when the response omits them;
      // supports_function_calling absent means tools=false.
      expect(result?.[0]?.metadata?.capabilities).toEqual({
        tools: false,
        input: ["text", "image"],
        output: ["text", "image"],
      });
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("invalid parameters limit and capabilities are skipped", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1" }]),
      parameters: () =>
        paramsBody({ max_tokens: -1, max_output_tokens: 100, supported_modalities: ["text", ""] }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "pi" }));
      // The fetch happened (invalid values, not a failed request), but neither
      // field survived parsing and nothing else contributed metadata.
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
      expect(result?.[0]?.metadata).toBeUndefined();
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });

  test("parameters merge: provider-rich limit wins, parameters fills capabilities", async () => {
    resetWarnedParametersKeys();
    const finish = installFetch({
      models: () => modelsBody([{ id: "m1", limit: { context: 8192, output: 4096 } }]),
      parameters: () =>
        paramsBody({ max_tokens: 1000, max_output_tokens: 50, supported_modalities: ["text"] }),
    });
    try {
      const result = await pollProvider(paramsTarget({ id: "pj" }));
      // Provider-rich limit survives; the parameters limit is discarded.
      expect(result?.[0]?.metadata?.limit).toEqual({ context: 8192, output: 4096 });
      // The field the standard pass lacked is backfilled from the same fetch.
      expect(result?.[0]?.metadata?.capabilities).toEqual({
        tools: false,
        input: ["text"],
        output: ["text"],
      });
      expect(finish.calls).toEqual(["/v1/models", "/api/models/parameters?model=m1"]);
    } finally {
      finish.restore();
      resetWarnedParametersKeys();
    }
  });
});
