/**
 * Boot-mode coverage: background boot (the default) must resolve setup with no
 * provider poll started and no catalog application during the host's boot
 * rebuilds — the host gates plugin activation on setup resolving, and each
 * catalog application of a rehydrated payload costs the host seconds of
 * per-model draft writes. The deferred kickoff arms the transform body and
 * runs the first cycle after `backgroundDeferMs`. Blocking boot keeps the
 * awaited cycle (and eager application) for callers that need discovered
 * models present before setup resolves.
 *
 * This file manages OPENCODE_MODELS_DISCOVERY_BACKGROUND{,_DEFER_MS} itself
 * so it is independent of the blocking pin discovery.test.ts sets.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_BACKGROUND_DEFER_MS,
  resolveBackgroundBoot,
  resolveBackgroundDeferMs,
  setModelsDevRegistryForTests,
  setup,
} from "opencode-v2-model-discovery";
import { STATE_FILE_ENV } from "./state.ts";

const BACKGROUND_ENV = "OPENCODE_MODELS_DISCOVERY_BACKGROUND";
const DEFER_ENV = "OPENCODE_MODELS_DISCOVERY_BACKGROUND_DEFER_MS";

/** Bounded poll: the mocked cycle has no real timers, so 5ms steps are ample. */
const flushUntil = async (pred: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

interface Harness {
  context: any;
  ticks: Array<() => void>;
  fetchCount: () => number;
  applied: () => string[];
  restore: () => void;
}

/** Env/cwd/state/config isolation plus tick, fetch and catalog-draft mocks. */
const makeHarness = (options: Record<string, unknown>, deferEnv = "50"): Harness => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sd-bg-*"));
  const configPath = path.join(dir, "explicit.json");
  fs.writeFileSync(configPath, "{}");
  const previousCwd = process.cwd();
  const previousEnv: Record<string, string | undefined> = {
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    [STATE_FILE_ENV]: process.env[STATE_FILE_ENV],
    [BACKGROUND_ENV]: process.env[BACKGROUND_ENV],
    [DEFER_ENV]: process.env[DEFER_ENV],
  };
  process.env.OPENCODE_CONFIG = configPath;
  process.env.OPENCODE_CONFIG_DIR = path.join(dir, "cfgdir");
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  process.env.HOME = path.join(dir, "home");
  delete process.env.OPENCODE_CONFIG_CONTENT;
  process.env[STATE_FILE_ENV] = path.join(dir, "opencode", "model-discovery", "state.json");
  process.env[DEFER_ENV] = deferEnv;
  process.chdir(dir);
  // Registry pre-seeded: the models.dev fetch must never show up in fetchCount.
  setModelsDevRegistryForTests(new Map());

  const previousSetInterval = globalThis.setInterval;
  const ticks: Array<() => void> = [];
  (globalThis as any).setInterval = (cb: () => void): number => {
    ticks.push(cb);
    return ticks.length;
  };
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ data: [{ id: "bg-model", name: "BG Model" }] }), {
      status: 200,
    });
  };

  const applied: string[] = [];
  let registered: ((draft: any) => void) | undefined;
  const draft = {
    provider: { list: () => [], get: () => undefined, update: () => {}, remove: () => {} },
    model: {
      get: () => undefined,
      update: (providerID: string, modelID: string, update: (model: any) => void) => {
        const model: any = {};
        update(model);
        applied.push(modelID);
      },
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
    },
  } as any;
  const context = {
    options: { providers: [{ id: "bg", baseURL: "https://bg.invalid/v1" }], ...options },
    catalog: {
      transform: async (callback: (draft: any) => void) => {
        registered = callback;
        return { dispose: async () => {} };
      },
      reload: async () => {
        registered?.(draft);
      },
    },
  } as any;

  return {
    context,
    ticks,
    fetchCount: () => fetches,
    applied: () => applied,
    restore: () => {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      globalThis.fetch = previousFetch;
      (globalThis as any).setInterval = previousSetInterval;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe("background boot", () => {
  test("default boot starts nothing inside setup; the deferred kickoff polls and applies", async () => {
    delete process.env[BACKGROUND_ENV];
    const harness = makeHarness({});
    try {
      const cleanup = await setup(harness.context);
      // Activation path: setup resolved with no poll and no catalog writes.
      expect(harness.fetchCount()).toBe(0);
      expect(harness.applied()).toEqual([]);
      // The deferred kickoff arms the body and runs the first cycle.
      await flushUntil(() => harness.fetchCount() === 1, "deferred first poll");
      await flushUntil(() => harness.applied().length > 0, "deferred catalog apply");
      expect(harness.applied()).toEqual(["bg-model"]);
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });

  test("the scheduler tick polls while unarmed but never writes the catalog", async () => {
    delete process.env[BACKGROUND_ENV];
    const harness = makeHarness({}, "60000");
    try {
      const cleanup = await setup(harness.context);
      expect(harness.ticks.length).toBe(1);
      harness.ticks[0]!();
      await flushUntil(() => harness.fetchCount() === 1, "tick poll");
      // The body stays quiet until the deferred kickoff arms it.
      expect(harness.applied()).toEqual([]);
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });

  test("cleanup before the kickoff cancels it: no poll, no catalog writes", async () => {
    delete process.env[BACKGROUND_ENV];
    const harness = makeHarness({}, "60000");
    try {
      const cleanup = await setup(harness.context);
      await cleanup?.();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(harness.fetchCount()).toBe(0);
      expect(harness.applied()).toEqual([]);
    } finally {
      harness.restore();
    }
  });

  test("background is the default even with the env unset (resolveBackgroundBoot)", () => {
    expect(resolveBackgroundBoot(undefined, undefined)).toBe(true);
    expect(resolveBackgroundBoot(undefined, "")).toBe(true);
  });

  test("option background:false blocks on the initial poll and beats a background env", async () => {
    process.env[BACKGROUND_ENV] = "1";
    const harness = makeHarness({ background: false });
    try {
      const cleanup = await setup(harness.context);
      expect(harness.fetchCount()).toBe(1);
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });

  test("a blocking env pin keeps the awaited cycle when no option is set", async () => {
    process.env[BACKGROUND_ENV] = "0";
    const harness = makeHarness({});
    try {
      const cleanup = await setup(harness.context);
      expect(harness.fetchCount()).toBe(1);
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });

  test("option background:true beats a blocking env pin", async () => {
    process.env[BACKGROUND_ENV] = "0";
    const harness = makeHarness({ background: true });
    try {
      const cleanup = await setup(harness.context);
      expect(harness.fetchCount()).toBe(0);
      await flushUntil(() => harness.fetchCount() === 1, "deferred first poll");
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });

  test("resolveBackgroundBoot precedence: option > env > default", () => {
    expect(resolveBackgroundBoot(false, "1")).toBe(false);
    expect(resolveBackgroundBoot(true, "0")).toBe(true);
    expect(resolveBackgroundBoot(undefined, "1")).toBe(true);
    expect(resolveBackgroundBoot(undefined, "true")).toBe(true);
    expect(resolveBackgroundBoot(undefined, "0")).toBe(false);
    expect(resolveBackgroundBoot(undefined, "false")).toBe(false);
    expect(resolveBackgroundBoot("yes", "1")).toBe(true);
    expect(resolveBackgroundBoot("yes", "0")).toBe(false);
  });

  test("resolveBackgroundDeferMs precedence and clamping", () => {
    expect(resolveBackgroundDeferMs(undefined, undefined)).toBe(DEFAULT_BACKGROUND_DEFER_MS);
    expect(resolveBackgroundDeferMs(undefined, "")).toBe(DEFAULT_BACKGROUND_DEFER_MS);
    expect(resolveBackgroundDeferMs(undefined, "abc")).toBe(DEFAULT_BACKGROUND_DEFER_MS);
    expect(resolveBackgroundDeferMs(undefined, "5000")).toBe(5000);
    expect(resolveBackgroundDeferMs(250, "5000")).toBe(250);
    expect(resolveBackgroundDeferMs("250", "5000")).toBe(5000);
    expect(resolveBackgroundDeferMs(undefined, "999999")).toBe(60_000);
    expect(resolveBackgroundDeferMs(undefined, "-5")).toBe(0);
    expect(resolveBackgroundDeferMs(undefined, "12.9")).toBe(12);
  });

  test("an option defer wins over the env defer in the live cycle", async () => {
    delete process.env[BACKGROUND_ENV];
    const harness = makeHarness({ backgroundDeferMs: 50 }, "60000");
    try {
      const cleanup = await setup(harness.context);
      await flushUntil(() => harness.fetchCount() === 1, "option-deferred first poll");
      await flushUntil(() => harness.applied().length > 0, "option-deferred apply");
      expect(harness.applied()).toEqual(["bg-model"]);
      await cleanup?.();
    } finally {
      harness.restore();
    }
  });
});
