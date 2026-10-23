#!/usr/bin/env bun
/**
 * Operator CLI for the discovery plugin. The host does not dispatch
 * `opencode run "/models-discovery-rescan"` (it treats the text as a prompt),
 * so the scriptable path is a trigger file that the plugin's scheduler
 * consumes. This CLI writes that file and reads the state file for results.
 *
 *   models-discovery status [--json]
 *   models-discovery rescan [--wait <seconds>]
 *   models-discovery path
 */

// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { mkdirSync, writeFileSync } from "node:fs";
// @ts-ignore -- runtime builtin; local types keep compilation dependency-free.
import { dirname } from "node:path";

import { loadStateFile, resolveStateFilePath, resolveTriggerFilePath } from "../state.ts";

const DEFAULT_WAIT_SECONDS = 90;
const DEFAULT_STATE_HINT =
  "Is the OpenCode service running with this plugin and this state path?";

function usage(): void {
  console.log(
    [
      "Usage: models-discovery <command>",
      "",
      "  status [--json]        Show persisted per-provider discovery clocks and last error.",
      "  rescan [--wait <s>]    Request an immediate force refresh; wait for the next cycle.",
      "  path                   Print the state and trigger file paths.",
      "",
      "Exit codes: 0 ok, 1 no cycle observed, 2 a provider failed.",
    ].join("\n"),
  );
}

function formatError(marker: string, status?: number, at?: string): string {
  const parts = [marker];
  if (status !== undefined) parts.push(`status=${status}`);
  if (at !== undefined) parts.push(`at=${at}`);
  return parts.join(" ");
}

function status(asJson: boolean): number {
  const statePath = resolveStateFilePath();
  const triggerPath = resolveTriggerFilePath(statePath);
  const state = loadStateFile(statePath);
  if (state === null) {
    console.error(`No readable discovery state at ${statePath}. ${DEFAULT_STATE_HINT}`);
    return 1;
  }
  if (asJson) {
    console.log(JSON.stringify({ statePath, triggerPath, ...state }, null, 2));
    return 0;
  }
  console.log(`state:   ${statePath}`);
  console.log(`trigger: ${triggerPath}`);
  for (const [id, entry] of Object.entries(state.providers)) {
    const error = entry.lastError
      ? ` last-error="${formatError(entry.lastError.marker, entry.lastError.status, entry.lastError.at)}"`
      : "";
    console.log(
      `${id} models=${entry.modelCount} last-success=${entry.lastSuccessAt} ` +
        `last-poll=${entry.lastPolledAt} trigger=${entry.lastTrigger}${error}`,
    );
  }
  if (state.lastRescanAt !== undefined) console.log(`last-rescan=${state.lastRescanAt}`);
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function rescan(waitSeconds: number): Promise<number> {
  const statePath = resolveStateFilePath();
  const triggerPath = resolveTriggerFilePath(statePath);
  const before = loadStateFile(statePath)?.lastRescanAt;

  try {
    mkdirSync(dirname(triggerPath), { recursive: true, mode: 0o700 });
    writeFileSync(triggerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    console.error(`Cannot write the trigger file at ${triggerPath}.`);
    return 1;
  }

  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  let state = loadStateFile(statePath);
  let observed = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const next = loadStateFile(statePath);
    if (next?.lastRescanAt !== undefined && next.lastRescanAt !== before) {
      state = next;
      observed = true;
      break;
    }
  }
  if (!observed || state === null) {
    console.error(`No rescan observed within ${waitSeconds}s. ${DEFAULT_STATE_HINT}`);
    return 1;
  }

  let failures = 0;
  for (const [id, entry] of Object.entries(state.providers)) {
    const error = entry.lastError
      ? ` last-error="${formatError(entry.lastError.marker, entry.lastError.status, entry.lastError.at)}"`
      : "";
    if (entry.lastError !== undefined) failures += 1;
    console.log(`${id} models=${entry.modelCount} last-success=${entry.lastSuccessAt}${error}`);
  }
  console.log(`rescan complete at ${state.lastRescanAt}`);
  return failures > 0 ? 2 : 0;
}

function main(argv: readonly string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return status(rest.includes("--json"));
    case "rescan": {
      const index = rest.indexOf("--wait");
      const raw = index >= 0 ? Number(rest[index + 1]) : DEFAULT_WAIT_SECONDS;
      const waitSeconds = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_WAIT_SECONDS;
      return rescan(waitSeconds);
    }
    case "path": {
      const statePath = resolveStateFilePath();
      console.log(`state:   ${statePath}`);
      console.log(`trigger: ${resolveTriggerFilePath(statePath)}`);
      return 0;
    }
    default:
      usage();
      return command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
}

process.exit(await main((process as unknown as { argv: string[] }).argv.slice(2)));
