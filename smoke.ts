// @ts-ignore -- runtime builtin; smoke keeps its host imports dependency-free.
import * as fs from "node:fs";
// @ts-ignore -- runtime builtin; smoke keeps its host imports dependency-free.
import * as os from "node:os";
// @ts-ignore -- runtime builtin; smoke keeps its host imports dependency-free.
import * as path from "node:path";
// @ts-ignore -- runtime builtin; smoke keeps its host imports dependency-free.
import { fileURLToPath } from "node:url";

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert(predicate(), `${label} did not complete`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function main(): Promise<void> {
  // Keep every config source under temp paths. This prevents smoke from
  // reading the operator's real global configuration.
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-config-"));
  const explicitConfigPath = path.join(configRoot, "explicit.json");
  const xdgConfigHome = path.join(configRoot, "xdg");
  const homeDir = path.join(configRoot, "home");
  const xdgConfigPath = path.join(xdgConfigHome, "opencode", "opencode.json");
  const defaultConfigPath = path.join(homeDir, ".config", "opencode", "opencode.json");
  for (const configPath of [explicitConfigPath, xdgConfigPath, defaultConfigPath]) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
  }

  const envKeys = [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_PROJECT_DISABLE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED",
    "OPENCODE_MODELS_DISCOVERY_STATE_FILE",
    "XDG_CONFIG_HOME",
    "HOME",
  ] as const;
  const previousEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  for (const key of envKeys) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OPENCODE_CONFIG = explicitConfigPath;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  process.env.HOME = homeDir;
  // Pin the discovery state file under the smoke config root so setup() calls
  // never read or write the operator's real state dir; configRoot is removed
  // in cleanup below.
  const smokeStatePath = path.join(configRoot, "model-discovery", "state.json");
  process.env.OPENCODE_MODELS_DISCOVERY_STATE_FILE = smokeStatePath;

  const { default: plugin, requestImmediateRefresh } = await import("opencode-v2-model-discovery");

  const restoreEnv = (): void => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  // Cases 1-2 run from a controlled cwd with a valid empty project config.
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-empty-"));
  fs.writeFileSync(path.join(tmpCwd, "opencode.json"), "{}");
  const prevCwd = process.cwd();
  process.chdir(tmpCwd);
  const noAutoCwdRestore = (): void => {
    process.chdir(prevCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  };

  assert(typeof plugin === "object" && plugin !== null, "default export must be an object");
  assert(typeof plugin.id === "string" && plugin.id.length > 0, "plugin.id must be a non-empty string");
  assert(typeof plugin.setup === "function", "plugin.setup must be a function");
  console.log("PASS: default export shape (id + setup)");

  // Case 1: empty options -> setup must resolve without throwing (no-op path)
  // and must not register a transform.
  let transformCalls1 = 0;
  const mockCtx1 = {
    options: {},
    catalog: {
      transform: async () => {
        transformCalls1 += 1;
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
  } as any;
  await plugin.setup(mockCtx1);
  assert(transformCalls1 === 0, "no-op path must not register a transform");
  console.log("PASS: setup with empty options resolved (no-op path)");

  // Case 2: one provider pointing at an unreachable localhost port -> poll
  // failure must be swallowed, setup must still resolve.
  const mockCtx2 = {
    options: {
      providers: [{ id: "unreachable", baseURL: "http://127.0.0.1:1" }],
    },
    catalog: {
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
  } as any;
  await plugin.setup(mockCtx2);
  console.log("PASS: setup with unreachable provider resolved (poll failure swallowed)");

  noAutoCwdRestore?.();

  // Case 3: auto-discovery from ./opencode.json + mock transform.
  const requestedPaths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requestedPaths.push(new URL(req.url).pathname);
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "auto-smoke-a", object: "model", created: 1710000000, owned_by: "stub" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-smoke-"));
  const pluginPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const sourceConfig = (source: string) => ({
    provider: {
      shared: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/${source}/v1` },
      },
      [`${source}-only`]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/${source}-only/v1` },
      },
    },
  });
  fs.writeFileSync(explicitConfigPath, JSON.stringify(sourceConfig("explicit"), null, 2));
  fs.writeFileSync(xdgConfigPath, JSON.stringify(sourceConfig("xdg"), null, 2));
  fs.writeFileSync(defaultConfigPath, JSON.stringify(sourceConfig("global"), null, 2));

  const fixtureConfig = {
    provider: {
      shared: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/project/v1` },
      },
      "project-only": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/project-only/v1` },
      },
      "other-prov": {
        npm: "@ai-sdk/anthropic",
        options: { baseURL: `${base}/v2` },
      },
      "off-prov": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/v1`, modelsDiscovery: false },
      },
      "forced-prov": {
        npm: "@ai-sdk/anthropic",
        options: { baseURL: `${base}/v3`, modelsDiscovery: { enabled: true } },
      },
    },
    providers: {
      "native-prov": {
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: `${base}/native/v1`, modelsDiscovery: true },
      },
    },
    plugin: [[pluginPath, { options: {} }]],
  };
  fs.writeFileSync(
    path.join(fixtureDir, "opencode.json"),
    JSON.stringify(fixtureConfig, null, 2),
  );

  const prevCwd3 = process.cwd();
  process.chdir(fixtureDir);

  let capturedTransform: ((draft: any) => void | Promise<void>) | null = null;
  const mockCtx3 = {
    options: {
      providers: [{ id: "manual-only", baseURL: `${base}/manual/v1` }],
    },
    catalog: {
      transform: async (cb: any) => {
        capturedTransform = cb;
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
  } as any;

  let setup3Threw: unknown = null;
  try {
    await plugin.setup(mockCtx3);
  } catch (err) {
    setup3Threw = err;
  }
  assert(
    setup3Threw === null,
    `setup (auto-discovery) must resolve, threw: ${String(setup3Threw)}`,
  );

  // Initial poll happens inside setup: seven merged auto targets plus one manual
  // target. The project "shared" entry must replace lower-precedence entries.
  const expectedPaths = [
    "/project/v1/models",
    "/explicit-only/v1/models",
    "/xdg-only/v1/models",
    "/global-only/v1/models",
    "/project-only/v1/models",
    "/v3/models",
    "/native/v1/models",
    "/manual/v1/models",
  ];
  assert(
    requestedPaths.length === expectedPaths.length,
    `stub must receive exactly ${expectedPaths.length} merged poll requests, got ${requestedPaths.length}: ${JSON.stringify(requestedPaths)}`,
  );
  for (const expectedPath of expectedPaths) {
    assert(requestedPaths.includes(expectedPath), `merged config must poll ${expectedPath}`);
  }
  for (const shadowedPath of ["/explicit/v1/models", "/xdg/v1/models", "/global/v1/models"]) {
    assert(!requestedPaths.includes(shadowedPath), `project shared provider must shadow ${shadowedPath}`);
  }
  assert(requestedPaths.includes("/v3/models"), "forced-prov must be polled (forced modelsDiscovery)");
  assert(!requestedPaths.includes("/v2/models"), "other-prov must not be polled");

  assert(capturedTransform !== null, "transform callback must be registered by setup");

  const calls: Array<{ pid: string; mid: string }> = [];
  const updatedNames: Array<{ pid: string; mid: string; name: string | undefined }> = [];
  const fakeDraft = {
    provider: {
      list: () => [
        {
          provider: {
            id: "shared",
            name: "shared",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `${base}/project/v1` },
          },
          models: new Map(),
        },
        {
          provider: { id: "other-prov", name: "other-prov", package: "aisdk:@ai-sdk/anthropic" },
          models: new Map(),
        },
        {
          provider: {
            id: "native-prov",
            name: "native-prov",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `${base}/native/v1` },
          },
          models: new Map(),
        },
      ],
      get: () => undefined,
      update: () => {},
      remove: () => {},
    },
    model: {
      get: () => undefined,
      update: (pid: string, mid: string, fn: (m: any) => void) => {
        calls.push({ pid, mid });
        const m = { id: mid, name: pid === "shared" ? "Configured shared name" : undefined } as any;
        fn(m);
        updatedNames.push({ pid, mid, name: m.name });
      },
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
    },
  } as any;
  await capturedTransform!(fakeDraft);

  assert(
    calls.some((c) => c.pid === "shared" && c.mid === "auto-smoke-a"),
    "transform must upsert auto-smoke-a for project-overridden shared provider",
  );
  assert(
    calls.some((c) => c.pid === "forced-prov" && c.mid === "auto-smoke-a"),
    "transform must upsert auto-smoke-a for forced-prov",
  );
  assert(
    calls.some((c) => c.pid === "manual-only" && c.mid === "auto-smoke-a"),
    "transform must upsert auto-smoke-a for manual-only provider",
  );
  assert(
    !calls.some((c) => c.pid === "other-prov"),
    "transform must not touch other-prov",
  );
  assert(
    calls.length === expectedPaths.length,
    `expected exactly ${expectedPaths.length} model updates, got ${calls.length}: ${JSON.stringify(calls)}`,
  );
  assert(
    updatedNames.some(
      (entry) =>
        entry.pid === "shared" && entry.mid === "auto-smoke-a" && entry.name === "Configured shared name",
    ),
    "transform must preserve a pre-existing custom model name",
  );
  console.log("PASS: merged config precedence + manual override + transform upserts");

  // Case 4: a successful poll removes vanished plugin-owned models but leaves
  // an operator-owned model untouched. The interval and fetch are injected so
  // this stays deterministic and never sleeps.
  const ownershipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-owned-"));
  const ownershipConfig = path.join(ownershipDir, "explicit.json");
  fs.writeFileSync(ownershipConfig, "{}");
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const ownershipIntervals: Array<() => void> = [];
  const ownershipModels = new Map<string, { id: string; name?: string }>([
    ["owned/custom-existing", { id: "custom-existing", name: "Operator custom name" }],
  ]);
  const ownershipRemovals: string[] = [];
  const ownershipRequests: string[] = [];
  let ownershipPhase = 0;
  let ownershipTransform: ((draft: any) => void | Promise<void>) | null = null;
  let ownershipReloads = 0;
  const ownershipDraft = {
    provider: { list: () => [], get: () => undefined, update: () => {}, remove: () => {} },
    model: {
      get: (pid: string, mid: string) => ownershipModels.get(`${pid}/${mid}`),
      update: (pid: string, mid: string, fn: (model: any) => void) => {
        const key = `${pid}/${mid}`;
        const model = ownershipModels.get(key) ?? { id: mid };
        fn(model);
        ownershipModels.set(key, model);
      },
      remove: (pid: string, mid: string) => {
        ownershipRemovals.push(`${pid}/${mid}`);
        ownershipModels.delete(`${pid}/${mid}`);
      },
      default: { get: () => undefined, set: () => {} },
    },
  } as any;
  (globalThis as any).fetch = async (input: RequestInfo | URL): Promise<Response> => {
    ownershipRequests.push(String(input));
    const ids =
      ownershipPhase === 0
        ? ["plugin-keep", "plugin-vanish", "custom-existing"]
        : ["plugin-keep", "custom-existing"];
    return jsonResponse({ data: ids.map((id) => ({ id })) });
  };
  (globalThis as any).setInterval = (callback: () => void): number => {
    ownershipIntervals.push(callback);
    return ownershipIntervals.length;
  };
  const previousCwd4 = process.cwd();
  process.env.OPENCODE_CONFIG = ownershipConfig;
  process.env.XDG_CONFIG_HOME = path.join(ownershipDir, "xdg");
  process.env.HOME = path.join(ownershipDir, "home");
  process.chdir(ownershipDir);
  const ownershipContext = {
    options: { providers: [{ id: "owned", baseURL: "https://owned.invalid/v1" }] },
    catalog: {
      transform: async (callback: any) => {
        ownershipTransform = callback;
        return { dispose: async () => {} };
      },
      reload: async () => {
        ownershipReloads += 1;
        await ownershipTransform?.(ownershipDraft);
      },
    },
  } as any;
  await plugin.setup(ownershipContext);
  assert(ownershipRequests.length === 1, "ownership fixture must perform one initial poll");
  assert(
    ownershipModels.get("owned/custom-existing")?.name === "Operator custom name",
    "existing custom model name must remain untouched",
  );
  assert(ownershipModels.has("owned/plugin-vanish"), "initial plugin model must be present");
  assert(ownershipIntervals.length === 1, "ownership fixture must capture one refresh callback");
  ownershipPhase = 1;
  // The captured callback is the 1s tick, not a refresh: force the refresh
  // through the same seam the rescan command and config watcher use.
  requestImmediateRefresh();
  await flushUntil(() => ownershipReloads === 2, "ownership refresh");
  assert(
    ownershipRemovals.includes("owned/plugin-vanish"),
    "successful poll must remove a vanished plugin-owned model",
  );
  assert(
    !ownershipRemovals.includes("owned/custom-existing"),
    "successful poll must not remove an unowned custom model",
  );
  assert(ownershipModels.has("owned/plugin-keep"), "retained plugin model must remain present");
  console.log("PASS: plugin-owned model cleanup + custom-name protection");
  process.chdir(previousCwd4);
  (globalThis as any).fetch = previousFetch;
  (globalThis as any).setInterval = previousSetInterval;
  fs.rmSync(ownershipDir, { recursive: true, force: true });

  // Case 5: a slow stale refresh cannot commit after a newer refresh changes
  // config. The removed provider must not be resurrected by stale results.
  const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-race-"));
  const raceConfig = path.join(raceDir, "explicit.json");
  const writeRaceConfig = (providers: Record<string, unknown>): void => {
    fs.writeFileSync(raceConfig, JSON.stringify({ provider: providers }));
  };
  const raceProvider = (baseURL: string) => ({
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL },
  });
  writeRaceConfig({
    slow: raceProvider("https://slow.example/v1"),
    deleted: raceProvider("https://deleted.example/v1"),
  });
  const previousFetchRace = globalThis.fetch;
  const previousSetIntervalRace = globalThis.setInterval;
  const raceIntervals: Array<() => void> = [];
  const raceModels = new Map<string, { id: string; name?: string }>();
  const raceRemovals: string[] = [];
  const raceRequests: string[] = [];
  let racePhase = 0;
  let slowRefreshStarted = false;
  let releaseSlowRefresh: (() => void) | null = null;
  let raceTransform: ((draft: any) => void | Promise<void>) | null = null;
  let raceReloads = 0;
  const raceDraft = {
    provider: { list: () => [], get: () => undefined, update: () => {}, remove: () => {} },
    model: {
      get: (pid: string, mid: string) => raceModels.get(`${pid}/${mid}`),
      update: (pid: string, mid: string, fn: (model: any) => void) => {
        const key = `${pid}/${mid}`;
        const model = raceModels.get(key) ?? { id: mid };
        fn(model);
        raceModels.set(key, model);
      },
      remove: (pid: string, mid: string) => {
        raceRemovals.push(`${pid}/${mid}`);
        raceModels.delete(`${pid}/${mid}`);
      },
      default: { get: () => undefined, set: () => {} },
    },
  } as any;
  (globalThis as any).fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    raceRequests.push(url);
    if (racePhase === 0 && url.includes("slow.example")) {
      return jsonResponse({ data: [{ id: "slow-initial" }] });
    }
    if (racePhase === 0 && url.includes("deleted.example")) {
      return jsonResponse({ data: [{ id: "deleted-initial" }] });
    }
    if (racePhase === 1 && url.includes("slow.example")) {
      slowRefreshStarted = true;
      return new Promise<Response>((resolve) => {
        releaseSlowRefresh = () => resolve(jsonResponse({ data: [{ id: "stale-slow" }] }));
      });
    }
    if (racePhase === 1 && url.includes("deleted.example")) {
      return jsonResponse({ data: [{ id: "deleted-stale" }] });
    }
    if (racePhase === 2 && url.includes("fast.example")) {
      return jsonResponse({ data: [{ id: "slow-latest" }] });
    }
    throw new Error("unexpected race request");
  };
  (globalThis as any).setInterval = (callback: () => void): number => {
    raceIntervals.push(callback);
    return raceIntervals.length;
  };
  const previousCwd5 = process.cwd();
  process.env.OPENCODE_CONFIG = raceConfig;
  process.env.XDG_CONFIG_HOME = path.join(raceDir, "xdg");
  process.env.HOME = path.join(raceDir, "home");
  delete process.env.OPENCODE_CONFIG_CONTENT;
  process.chdir(raceDir);
  const raceContext = {
    options: {},
    catalog: {
      transform: async (callback: any) => {
        raceTransform = callback;
        return { dispose: async () => {} };
      },
      reload: async () => {
        raceReloads += 1;
        await raceTransform?.(raceDraft);
      },
    },
  } as any;
  await plugin.setup(raceContext);
  assert(raceReloads === 1, "race fixture must complete its initial reload");
  assert(raceModels.has("slow/slow-initial"), "race fixture must own initial slow model");
  assert(raceModels.has("deleted/deleted-initial"), "race fixture must own initial deleted model");
  assert(raceIntervals.length === 1, "race fixture must capture one refresh callback");

  racePhase = 1;
  requestImmediateRefresh();
  await flushUntil(() => slowRefreshStarted, "slow stale refresh start");
  writeRaceConfig({ slow: raceProvider("https://fast.example/v1") });
  racePhase = 2;
  requestImmediateRefresh();
  assert(
    !raceRequests.some((url) => url.includes("fast.example")),
    "newer refresh must wait behind the slow refresh without overlapping polls",
  );
  const release = releaseSlowRefresh as (() => void) | null;
  assert(release !== null, "slow refresh gate must be releasable");
  release!();
  await flushUntil(() => raceReloads === 2, "latest refresh commit");
  assert(raceRequests.some((url) => url.includes("fast.example")), "latest refresh must poll new target");
  assert(raceModels.has("slow/slow-latest"), "latest refresh model must commit");
  assert(!raceModels.has("slow/stale-slow"), "stale refresh model must not commit");
  assert(!raceModels.has("deleted/deleted-initial"), "deleted provider must be cleaned up");
  assert(
    raceRemovals.includes("deleted/deleted-initial"),
    "deleted provider cleanup must remove its plugin-owned model",
  );
  console.log("PASS: serialized latest refresh prevents stale resurrection");
  process.chdir(previousCwd5);
  (globalThis as any).fetch = previousFetchRace;
  (globalThis as any).setInterval = previousSetIntervalRace;
  fs.rmSync(raceDir, { recursive: true, force: true });

  // Case 6: setup, registration, and reload failures are swallowed, and
  // warnings contain only safe operation/marker/status fields.
  const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-failure-"));
  const failureConfig = path.join(failureDir, "explicit.json");
  fs.writeFileSync(
    failureConfig,
    JSON.stringify({
      provider: {
        secret: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://secret.invalid/v1", apiKey: "fake-key" },
        },
      },
    }),
  );
  const previousFetchFailure = globalThis.fetch;
  const previousSetIntervalFailure = globalThis.setInterval;
  const failureIntervals: Array<() => void> = [];
  const previousWarn = console.warn;
  const previousLog = console.log;
  const warnings: string[] = [];
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  (globalThis as any).fetch = async (): Promise<Response> => {
    throw new Error("raw-error");
  };
  (globalThis as any).setInterval = (callback: () => void): number => {
    failureIntervals.push(callback);
    return failureIntervals.length;
  };
  const previousCwd6 = process.cwd();
  process.env.OPENCODE_CONFIG = failureConfig;
  process.env.XDG_CONFIG_HOME = path.join(failureDir, "xdg");
  process.env.HOME = path.join(failureDir, "home");
  process.env.OPENCODE_CONFIG_CONTENT = "{}";
  process.chdir(failureDir);

  let registrationThrew = false;
  try {
    await plugin.setup({
      options: {},
      catalog: {
        transform: async () => {
          throw new Error("registration-raw");
        },
        reload: async () => {},
      },
    } as any);
  } catch {
    registrationThrew = true;
  }
  assert(!registrationThrew, "registration failure must not escape setup");

  let reloadThrew = false;
  try {
    await plugin.setup({
      options: {},
      catalog: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {
          throw new Error("reload-raw");
        },
      },
    } as any);
  } catch {
    reloadThrew = true;
  }
  assert(!reloadThrew, "reload failure must not escape setup");

  let setupThrew = false;
  const throwingContext = {} as any;
  Object.defineProperty(throwingContext, "options", {
    get: () => {
      throw new Error("setup-raw");
    },
  });
  try {
    await plugin.setup(throwingContext);
  } catch {
    setupThrew = true;
  }
  assert(!setupThrew, "top-level setup failure must not escape setup");
  const warningText = [...warnings, ...logs].join("\n");
  for (const unsafe of [
    "https://secret.invalid/v1",
    "fake-key",
    "raw-error",
    "registration-raw",
    "reload-raw",
    "setup-raw",
  ]) {
    assert(!warningText.includes(unsafe), `safe warnings must omit ${unsafe}`);
  }
  // Two allowed sanitized shapes: (a) safe-warn helpers exposing marker/config
  // + status fields; (b) the catalog-surface degradation warning, sanitized by
  // construction (error NAME only — never message/stack), fixed suffix.
  assert(
    warnings.length > 0 &&
      warnings.every((warning) =>
        /(?:marker=|config=).+status=(?:unknown|\d+)|^\[opencode-v2-model-discovery\] catalog surface "[^"]+" unusable \(error=[A-Za-z][A-Za-z0-9]*\); polling only\.$/.test(
          warning,
        ),
      ),
    `safe warnings must expose only marker/config and status fields: ${warningText}`,
  );
  console.warn = previousWarn;
  console.log = previousLog;
  process.chdir(previousCwd6);
  (globalThis as any).fetch = previousFetchFailure;
  (globalThis as any).setInterval = previousSetIntervalFailure;
  fs.rmSync(failureDir, { recursive: true, force: true });
  console.log("PASS: setup failure guards and sanitized logs");

  // Cleanup
  process.chdir(prevCwd3);
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(configRoot, { recursive: true, force: true });
  server.stop();
  restoreEnv();

  console.log("All smoke checks passed.");
  // Explicit exit: setup schedules a 1s poll ticker and config watchers; do
  // not let pending timers keep the process alive.
  process.exit(0);
}

await main();
