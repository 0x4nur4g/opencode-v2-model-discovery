/** Runtime-free slices of the host plugin and catalog contracts. */

type CleanupLite = () => Promise<void> | void;

interface CatalogRegistrationLite {
  dispose(): Promise<void>;
}

interface ModelInfoLite {
  name: string;
}

interface CatalogDraftLite {
  model: {
    get(providerID: string, modelID: string): ModelInfoLite | undefined;
    update(providerID: string, modelID: string, update: (model: ModelInfoLite) => void): void;
    remove(providerID: string, modelID: string): void;
  };
  provider?: {
    list(): readonly unknown[];
  };
}

/** v2.0.4+ model-namespace draft: the model methods live on the draft itself. */
interface ModelNamespaceDraftLite {
  get(providerID: string, modelID: string): ModelInfoLite | undefined;
  update(providerID: string, modelID: string, update: (model: ModelInfoLite) => void): void;
  remove(providerID: string, modelID: string): void;
  provider?: {
    list(): readonly unknown[];
  };
}

interface CommandContextLite {
  /** Session the command was invoked in; absent for headless invocations. */
  sessionID?: string;
  prompt?: { text?: string };
  delivery?: string;
}

interface CommandDraftLite {
  add(command: {
    name: string;
    description?: string;
    execute: (context?: CommandContextLite) => unknown | Promise<unknown>;
  }): void;
}

interface CommandTransformApiLite {
  transform(
    callback: (draft: CommandDraftLite) => void,
  ): Promise<{ dispose(): Promise<void> | void }>;
}

interface PluginContextLite {
  options: Readonly<Record<string, unknown>>;
  /**
   * Pre-2.0.4 catalog surface (beta line through v2.0.3): a single transform
   * whose draft exposes both `model` and `provider` namespaces. Absent on
   * runtimes that moved to the split surface below.
   */
  catalog?: {
    transform(callback: (draft: CatalogDraftLite) => void): Promise<CatalogRegistrationLite>;
    reload?(): Promise<void>;
  };
  /**
   * v2.0.4+ split surface: `ctx.model.transform` receives the model namespace
   * itself as the draft (get/update/remove/default, plus a `provider` key for
   * join reads); `ctx.provider.transform` owns provider records. Verified live
   * on v2.0.4 (2026-09-16): `ctx.catalog` is undefined there.
   */
  model?: {
    transform(callback: (draft: ModelNamespaceDraftLite) => void): Promise<CatalogRegistrationLite>;
    reload?(): Promise<void>;
  };
  /** OpenCode integration store; absent in mocks and older runtimes. */
  integration?: IntegrationApiLite;
  /** Command registration surface; absent on runtimes without the command API. */
  command?: CommandTransformApiLite;
  /**
   * Session surface for user-visible command acknowledgements; absent in
   * mocks and runtimes without it. `synthetic` posts a synthetic session
   * message without triggering an agent run.
   */
  session?: {
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>;
  };
  /** Event subscription surface; no unsubscribe handle is exposed. */
  event?: {
    subscribe(topic: string, cb: (...args: unknown[]) => void): unknown;
  };
}

interface IntegrationConnectionLite {
  type: string;
  id?: string;
  label?: string;
  name?: string;
}

interface CredentialValueLite {
  type: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

interface IntegrationConnectionApiLite {
  active(integrationID: string): Promise<IntegrationConnectionLite | undefined>;
  resolve(connection: IntegrationConnectionLite): Promise<CredentialValueLite | undefined>;
}

interface IntegrationApiLite {
  connection?: IntegrationConnectionApiLite;
}

interface PluginDefinitionLite {
  id: string;
  setup: (context: PluginContextLite) => CleanupLite | Promise<CleanupLite | void> | void;
}

interface ProcessLite {
  env: Record<string, string | undefined>;
  cwd(): string;
  chdir(directory: string): void;
  exit(code?: number): never;
  /** OS process id; used only to uniquify state-file temp names. */
  pid: number;
}

interface BunServerLite {
  readonly port: number;
  stop(): void;
}

interface BunRuntimeLite {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServerLite;
}

declare var Bun: BunRuntimeLite;
declare var process: ProcessLite;
