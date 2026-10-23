/**
 * TUI half of the model-discovery plugin (zero deps: no top-level imports).
 *
 * Shadows `ctrl+t` (priority 10) on models with no reasoning-effort variants —
 * where the native variant cycle is a silent no-op: the first press hints and
 * arms a 5 s window (with no open session it warns and arms nothing), the
 * second press triggers `models-discovery-merge`. With variants present the
 * handler performs the native variant cycle itself — returning `false` from a
 * priority-10 layer does not resume the built-in binding live (v2.0.19).
 */

type TuiModelRef = { providerID: string; modelID: string; variant?: string };

/** All members optional: every surface is probed defensively at use time. */
type TuiCtxLite = {
  ui?: {
    model?: {
      variant?: {
        list?: () => string[];
        cycle?: () => unknown;
        set?: (variant: string) => unknown;
      };
      current?: () => TuiModelRef | undefined;
    };
    toast?: { show?: (input: { message: string; variant?: string; title?: string }) => void };
    router?: { current?: () => { type: string; sessionID?: string } | undefined };
    slot?: (claim: { append: string; render: () => unknown }) => void;
  };
  keymap?: { layer?: (register: () => unknown) => void };
  client?: {
    session?: {
      command?: (input: { sessionID: string; name: string; text: string }) => Promise<unknown>;
    };
  };
};

type EffortSnapshot = { providerID: string; modelID: string; sessionID?: string; at: number };

const HINT_MESSAGE =
  "No reasoning efforts exist for this model. Press Ctrl+T again to trigger discovery.";
const ARM_WINDOW_MS = 5000;
const TRIGGER_COOLDOWN_MS = 5000;
const MERGE_COMMAND = "models-discovery-merge";

let pending: EffortSnapshot | undefined;
let cooldownUntil = 0;

/**
 * Pure two-press policy. `delegate` means variants exist — the handler then
 * performs the native variant cycle itself. `hint` arms (or re-arms) a
 * snapshot; `trigger` runs the merge command; `block-no-session` means no open
 * session — nothing is armed (pending is cleared), because a trigger could not
 * run.
 */
export function decideEffortShortcut(input: {
  variants: string[];
  current?: { providerID: string; modelID: string };
  sessionID?: string;
  pending?: { providerID: string; modelID: string; sessionID?: string; at: number } | undefined;
  cooldownUntil?: number;
  now: number;
}): {
  action: "delegate" | "hint" | "trigger" | "block-no-session";
  pending?: typeof input.pending;
  command?: { name: string; text: string };
} {
  if (input.variants.length > 0) return { action: "delegate" };
  // No open session: the "press again" promise would be false and a trigger
  // cannot run, so report it and never arm.
  if (input.sessionID === undefined) return { action: "block-no-session", pending: undefined };
  if (input.current === undefined) return { action: "hint" };
  const snapshot: EffortSnapshot = {
    providerID: input.current.providerID,
    modelID: input.current.modelID,
    sessionID: input.sessionID,
    at: input.now,
  };
  const armed =
    input.pending !== undefined &&
    input.pending.providerID === snapshot.providerID &&
    input.pending.modelID === snapshot.modelID &&
    input.pending.sessionID === snapshot.sessionID &&
    input.now - input.pending.at <= ARM_WINDOW_MS &&
    input.now >= (input.cooldownUntil ?? 0);
  if (armed && input.pending !== undefined) {
    return { action: "trigger", command: { name: MERGE_COMMAND, text: input.pending.providerID } };
  }
  return { action: "hint", pending: snapshot };
}

function safeVariantIds(ctx: TuiCtxLite): string[] {
  try {
    const ids = ctx.ui?.model?.variant?.list?.();
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function safeCurrentModel(ctx: TuiCtxLite): { providerID: string; modelID: string } | undefined {
  try {
    const current = ctx.ui?.model?.current?.();
    if (current === undefined) return undefined;
    if (typeof current.providerID !== "string" || current.providerID.length === 0) return undefined;
    if (typeof current.modelID !== "string" || current.modelID.length === 0) return undefined;
    return { providerID: current.providerID, modelID: current.modelID };
  } catch {
    return undefined;
  }
}

function safeSessionId(ctx: TuiCtxLite): string | undefined {
  try {
    const route = ctx.ui?.router?.current?.();
    if (route === undefined || route.type !== "session") return undefined;
    return typeof route.sessionID === "string" && route.sessionID.length > 0
      ? route.sessionID
      : undefined;
  } catch {
    return undefined;
  }
}

function toast(ctx: TuiCtxLite, input: { message: string; variant?: string; title?: string }): void {
  try {
    ctx.ui?.toast?.show?.(input);
  } catch {
    // A toast failure must never break the keypress.
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && typeof error.name === "string" && error.name.length > 0
    ? error.name
    : "Error";
}

/** Sets a variant when the surface exists; true only when the set succeeded. */
function trySetVariant(ctx: TuiCtxLite, variant: string): boolean {
  const set = ctx.ui?.model?.variant?.set;
  if (typeof set !== "function") return false;
  try {
    return set.call(ctx.ui?.model?.variant, variant) !== false;
  } catch {
    return false;
  }
}

/**
 * Delegate path: perform the native cycle directly. The documented `return
 * false` fallthrough does NOT resume the built-in `variant.cycle` on v2.0.19 —
 * the priority-10 layer consumes `ctrl+t` — so prefer the native cycle surface,
 * else emulate it through list/current/set, else keep the doc-intent `false`.
 */
function cycleNativeVariants(ctx: TuiCtxLite): boolean {
  const variantApi = ctx.ui?.model?.variant;
  if (typeof variantApi?.cycle === "function") {
    try {
      if (variantApi.cycle.call(variantApi) !== false) return true;
    } catch {
      // Fall through to the emulation path.
    }
  }
  const ids = safeVariantIds(ctx);
  if (ids.length === 0) return false;
  let current = "default";
  try {
    current = ctx.ui?.model?.current?.()?.variant ?? "default";
  } catch {
    current = "default";
  }
  const seq = ["default", ...ids];
  const next = seq[(seq.indexOf(current) + 1) % seq.length] ?? ids[0];
  if (next === "default") {
    return trySetVariant(ctx, "default") || trySetVariant(ctx, ids[0]);
  }
  return trySetVariant(ctx, next);
}

async function handler(ctx: TuiCtxLite): Promise<boolean> {
  try {
    const now = Date.now();
    const sessionID = safeSessionId(ctx);
    const decision = decideEffortShortcut({
      variants: safeVariantIds(ctx),
      current: safeCurrentModel(ctx),
      sessionID,
      pending,
      cooldownUntil,
      now,
    });

    if (decision.action === "delegate") return cycleNativeVariants(ctx);

    if (decision.action === "hint") {
      toast(ctx, { message: HINT_MESSAGE, variant: "warning", title: "Models discovery" });
      pending = decision.pending;
      return true;
    }

    if (decision.action === "block-no-session") {
      toast(ctx, {
        message: "Open a chat session first — merge results arrive in the chat.",
        variant: "warning",
      });
      pending = decision.pending;
      return true;
    }

    const providerID = decision.command?.text ?? "";
    pending = undefined;
    cooldownUntil = now + TRIGGER_COOLDOWN_MS;
    try {
      const session = ctx.client?.session;
      const command = session?.command;
      if (sessionID === undefined || typeof command !== "function") {
        throw new TypeError("session command unavailable");
      }
      await command.call(session, { sessionID, name: MERGE_COMMAND, text: providerID });
      toast(ctx, {
        message: `Discovery merge started for ${providerID}.`,
        variant: "success",
        title: "Models discovery",
      });
    } catch (error) {
      toast(ctx, { message: `Merge trigger failed: ${safeErrorName(error)}`, variant: "error" });
    }
    return true;
  } catch {
    return true; // a keypress handler must never throw
  }
}

/**
 * Live-proven registration: `keymap.layer` throws
 * `Error: Keymap.Provider is missing` when called straight from `setup`, so
 * the layer is claimed from a slot render instead. Fail-soft everywhere.
 */
export function setup(context: unknown): void {
  const ctx = context as TuiCtxLite;
  let registered = false;

  const registerLayer = (): void => {
    if (registered) return;
    try {
      ctx.keymap?.layer?.(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "models-discovery.effort-shortcut",
            title: "Models Discovery: effort shortcut",
            group: "Models Discovery",
            bind: "ctrl+t",
            run: () => handler(ctx),
          },
        ],
        bindings: ["models-discovery.effort-shortcut"],
      }));
      registered = true;
    } catch {
      // Fail soft; the next slot render retries.
    }
  };

  try {
    ctx.ui?.slot?.({
      append: "app",
      render: () => {
        registerLayer();
        return null;
      },
    });
  } catch {
    // Fail soft: no slot surface means no registration path.
  }
}

export default { id: "opencode-v2-model-discovery", setup };
