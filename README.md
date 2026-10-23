# opencode-v2-model-discovery

OpenCode v2 plugin that auto-discovers models from any OpenAI-compatible provider and keeps opencode's model catalog in sync — with reasoning-effort variants, context limits, and capabilities.

The plugin polls each provider's `/models` endpoint and upserts every discovered model into the live catalog, optionally enriching them with reasoning-effort variants, token limits, and tool/modalities capabilities. Zero runtime dependencies, no build step, one config line to install.

## Install

**Git (recommended):**

```jsonc
// ~/.config/opencode/opencode.json (or project opencode.json)
{
  "plugins": [
    { "package": "github:0x4nur4g/opencode-v2-model-discovery", "options": { "cacheFor": 86400 } }
  ]
}
```

Works on any machine with git access. Pin a commit with `github:0x4nur4g/opencode-v2-model-discovery#<commit>`, or use `#main` to follow updates.

**Local checkout:**

```jsonc
{ "package": "/absolute/path/to/opencode-v2-model-discovery" }
```

Requires opencode v2 (beta line). Register the plugin by directory path or package spec (git/npm) — the current beta ignores single-file paths.

## Quick start

```jsonc
{
  "providers": {
    "bifrost": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "http://localhost:9090/v1",
        "apiKey": "{env:BIFROST_API_KEY}"
      },
      "options": { "modelsDiscovery": { "enrich": true } }
    }
  },
  "plugins": [
    { "package": "github:0x4nur4g/opencode-v2-model-discovery", "options": { "cacheFor": 86400 } }
  ]
}
```

That's it. A provider is auto-discovered when its `package`/`npm` value contains `openai-compatible` **or** its `baseURL` has a `/v1` path segment. Force or skip per provider with `"modelsDiscovery": true | false | { "enabled": true, "enrich": true }`.

Models appear in the catalog within one poll cycle (default 300 s) — or run the `models-discovery-rescan` command in opencode for an immediate refresh.

## Configuration

Every option resolves through the same chain, highest first: per-provider → plugin options → env var → default.

| Option | Scope | Default | Description |
| --- | --- | --- | --- |
| `modelsDiscovery` | provider | auto | `true`/`false` force or skip discovery; the object form enables the per-provider options below. |
| `modelsDiscovery.enabled` | provider | auto | `true` forces, `false` skips. |
| `modelsDiscovery.enrich` | provider | off | Object-form opt-in (`{"enrich": true}`) for variants, limits, and capabilities. |
| `modelsDiscovery.endpoint` | provider | `${baseURL}/models` | Poll this URL instead (relative URLs resolve against `baseURL`). |
| `modelsDiscovery.intervalSeconds` | provider | `300` | Per-provider poll interval; min `15`. |
| `modelsDiscovery.cacheFor` | provider | off | Success-only cache TTL; min `60`. Off polls on every interval. |
| `modelsDiscovery.pollTimeoutSeconds` | provider | `20` | Stall window: abort after this long with **no bytes** (headers or body). Hard ceiling is 10x this value for the whole exchange; min `5`. |
| `modelsDiscovery.parametersPath` | provider | off | Per-model parameters endpoint for providers whose `/models` lacks effort data (e.g. `/api/models/parameters`). |
| `modelsDiscovery.requireAuth` | provider | plugin/env | Poll only when a credential resolves; otherwise skip the provider for that cycle. |
| `modelsDiscovery.query` | provider | off | Query parameters added to every poll request, e.g. `{ "fields": "id,name" }`. |
| `modelsDiscovery.pagination` | provider | off | Page walking: `{ pageParam, perPageParam, perPage, maxPages }` (defaults `page`, off, off, `10`; max `100`). Stops on a short/empty/repeated page. |
| `intervalSeconds` | plugin / env | `300` | Poll interval for every target; min `15`. |
| `cacheFor` | plugin / env | off | Success-only cache TTL; min `60`. |
| `pollTimeoutSeconds` | plugin / env | `20` | Stall window for every target; min `5`. |
| `parametersPath` | plugin / env | off | Global fallback parameters endpoint. |
| `requireAuth` | plugin / env | off | Global default for `modelsDiscovery.requireAuth`. |
| `authBackoffSeconds` | plugin / env | `1800` | Pause after a 401/403 before that provider is polled again; `0` disables; min `60`. |
| `background` | plugin / env | `true` | Boot mode: `true` runs the first poll after `setup` resolves (off the host's plugin-activation path); `false` awaits the first poll inside `setup`. |
| `backgroundDeferMs` | plugin / env | `3000` | Background boot only: delay before the transform body arms and the first cycle runs; clamped `0`..`60000`. |
| `providers` | plugin | — | Manual targets: `{ id, baseURL, apiKeyEnv, headers, filter, integrationID, enabled, requireAuth, query, pagination }`. `enabled: false` blocks a provider id entirely. |
| `filter` | provider / manual target | — | Only inject model ids containing this substring. |
| `apiKey` | provider | — | Literal or `{env:VAR}` interpolation; sent as `Authorization: Bearer …`. |
| `apiKeyEnv` | provider / manual target | — | Environment variable holding the key. |
| `headers` | provider / manual target | — | Extra headers on every request. |
| `OPENCODE_MODELS_DISCOVERY_INTERVAL_SECONDS` | env | — | Overrides `intervalSeconds`. |
| `OPENCODE_MODELS_DISCOVERY_CACHE_FOR_SECONDS` | env | — | Overrides `cacheFor`. |
| `OPENCODE_MODELS_DISCOVERY_POLL_TIMEOUT_SECONDS` | env | — | Overrides `pollTimeoutSeconds`. |
| `OPENCODE_MODELS_DISCOVERY_REQUIRE_AUTH` | env | — | Overrides `requireAuth` (`true`/`false`, also `1`/`0`). |
| `OPENCODE_MODELS_DISCOVERY_AUTH_BACKOFF_SECONDS` | env | — | Overrides `authBackoffSeconds`. |
| `OPENCODE_MODELS_DISCOVERY_TRIGGER_FILE` | env | — | Override the rescan trigger file path (see CLI below). |
| `OPENCODE_MODELS_DISCOVERY_PARAMETERS_PATH` | env | — | Overrides `parametersPath`. |
| `OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED` | env | — | Default on/off when a provider has no explicit `modelsDiscovery` flag. |
| `OPENCODE_MODELS_DISCOVERY_STATE_FILE` | env | — | Override the state file path (see below). |
| `OPENCODE_MODELS_DISCOVERY_BACKGROUND` | env | — | Overrides `background` (`true`/`false`, also `1`/`0`). |
| `OPENCODE_MODELS_DISCOVERY_BACKGROUND_DEFER_MS` | env | — | Overrides `backgroundDeferMs`. |

Authentication per poll, in order: `apiKeyEnv` environment value → config `apiKey` (literal or `{env:VAR}`) → OpenCode credential store (`opencode auth login`). Keys are never logged; an unset `{env:VAR}` reference polls without auth and warns once. Set `requireAuth` (per provider or globally) to skip such a provider instead of importing a public catalog whose models cannot actually be called. One credential per provider id — multiple store keys under one provider are not unioned (see `docs/opencode-v2-plugin-credential-resolution.md`). A 401/403 pauses the provider for `authBackoffSeconds`; a config edit or a rescan clears the pause immediately.

## What gets enriched

With `{"enrich": true}`, provider metadata maps onto opencode's catalog schema. Precedence is per field: provider-rich data wins each field it supplies, and the opencode catalog join fills the rest.

| Field | Sources | Notes |
| --- | --- | --- |
| `variants` | `reasoning.supported_efforts`, `reasoning_options`, `additional_attributes.reasoning_efforts` (CSV), explicit `variants` | Mapped to `variants[].settings.reasoningEffort`. Efforts are never inferred from a bare `reasoning: true`. |
| `limit` | `context_length`, `max_input_tokens`, `max_output_tokens`, `max_completion_tokens` | Needs context + output from the provider; join fills the rest. |
| `capabilities` | `modalities` / `architecture` input-output modalities, `tools` (boolean signal or `supported_features` "tools" token) | Same per-field merge. |

An optional `parametersPath` endpoint (e.g. Bifrost's `/api/models/parameters`) backfills models that still lack effort variants, one lazy per-model fetch: `reasoning_effort_levels` → variants, `max_tokens` / `max_input_tokens` / `max_output_tokens` → limit, `supported_modalities` / `supports_function_calling` → capabilities. Failures skip that model for the cycle and never block the rest of the poll.

## Behavior

- Failed polls (timeout, non-2xx, bad JSON) keep the provider's last-good models — a transient outage never empties the catalog. Acks and the state file name the sanitized cause (`status=401`, `poll-timeout`, `response-parse`, `response-shape`, `pagination`), and acks distinguish "kept last known" from "failed, no previous models".
- A provider that answers 401/403 is paused for `authBackoffSeconds` (default 30 min, `0` disables) instead of being retried every interval; a config edit or a rescan retries it immediately.
- The fetch timeout is a **stall** window: the abort fires only after that long with no bytes, so a large catalog that is still streaming is never cut off mid-body. An abort reports `poll-timeout`, never `response-parse`; the parse marker now means malformed JSON only.
- A successful empty poll removes previously discovered models; models you registered yourself are never touched.
- Your own model names are preserved — the plugin only names a model when none exists.
- The `models-discovery-rescan` command posts session acknowledgements: a "started" message immediately, then a sanitized summary (`N model(s) across M provider(s)`, plus any providers that failed and kept their last known models) when the cycle completes. The acknowledgements are inbox-only notes — they schedule no agent run and only surface with the next natural session drain. Invocations without a session stay silent.
- The `models-discovery-merge` command (`/models-discovery-merge <provider>`) fills ONLY missing metadata fields — it never overwrites an existing `capabilities`/`limit`/`variants` value. It accepts a config discovery target id or a native (models.dev) provider id; with no argument it merges all config targets (native providers need an explicit id). Acks are inbox-only session notes (no scheduled agent run) and headless invocations stay silent, same as rescan.
- `cacheFor` gates on the last **successful** poll; caching never delays recovery. The `models-discovery-rescan` command bypasses interval and TTL.
- Config edits apply via the config-file watch (~0.5 s debounce) or the next poll cycle.
- Refreshes are serialized with a generation guard: a slow poll can't commit stale results over a newer one.
- Boot is background by default: `setup` resolves without waiting for the first poll, and the transform body stays quiet through the host's boot-time catalog rebuilds (each application of a rehydrated payload costs the host seconds of per-model draft writes). The deferred kickoff (`backgroundDeferMs`, default 3000 ms) arms the body and runs the first cycle right after boot, so discovered models appear moments later instead of gating readiness. Set `background: false` (or `OPENCODE_MODELS_DISCOVERY_BACKGROUND=false`) to await the first cycle inside `setup` with eager application instead.

## Command line

Slash commands do not dispatch from a headless shell (`opencode run "/models-discovery-rescan"` starts a normal agent turn). For scripts, use the bundled CLI:

```bash
bun link                     # once, in this directory
models-discovery status      # persisted clocks/counts + last sanitized error per provider
models-discovery rescan      # request an immediate force refresh and wait for it
models-discovery path        # state and trigger file paths
```

`rescan` writes the trigger file (default `refresh-request` next to the state file, override with `OPENCODE_MODELS_DISCOVERY_TRIGGER_FILE`); the plugin checks it once per scheduler tick, deletes it, and runs a force cycle that bypasses interval, TTL, parameter cache, and auth pauses. Exit codes: `0` ok, `1` no cycle observed (service not running with this state path), `2` at least one provider failed.

## State file

The plugin snapshots poll clocks and counts to `${XDG_STATE_HOME:-~/.local/state}/opencode/model-discovery/state.json` so you can `cat` it to see what happened; override the path with `OPENCODE_MODELS_DISCOVERY_STATE_FILE`.

```json
{
  "version": 2,
  "providers": {
    "bifrost": {
      "lastSuccessAt": "2026-09-09T10:00:00.000Z",
      "lastPolledAt": "2026-09-09T10:00:00.000Z",
      "modelCount": 248,
      "cacheForSeconds": 86400,
      "lastTrigger": "poll",
      "models": [{ "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash" }]
    }
  },
  "lastRescanAt": "2026-09-09T10:05:00.000Z"
}
```

- Written once per refresh cycle that polled any provider, after the catalog commit succeeds; the `models-discovery-rescan` command also stamps `lastRescanAt`.
- `lastSuccessAt` is success-only: failed polls never advance it, so `cacheFor` semantics survive on disk. A `1970-01-01T00:00:00.000Z` value means "never succeeded".
- `lastError` (optional) carries the last sanitized failure — `{ "marker": "status", "status": 401, "at": "…" }` — and is removed after the next successful poll. This is the durable diagnostic surface: plugin console output does not reach `opencode.log`.
- At startup the file seeds the clocks — a provider inside its `cacheFor` TTL stays cached across restarts.
- It also seeds the discovered `models` payloads. The catalog lives in the server process only (nothing persists it to disk), so without this a restart inside a TTL would skip polling *and* have nothing to upsert — providers absent from config and from the models.dev registry would show zero models until the TTL expired. Rehydrated models re-apply through the same catalog transform, with no network call.
- Atomic write (temp file + rename); file mode `0600`, directory `0700`. A write failure only warns.
- Never stores credentials or URLs — timestamps, counts, trigger, TTL, and the discovered model payloads (ids, names, enrichment metadata) only.
- A `version: 1` file (clocks only) is ignored: the upgrade path is one cold-start poll cycle, which rewrites it as `version: 2`.

## Merge command

`/models-discovery-merge <provider>` runs a one-shot discovery poll with enrichment forced on, then gap-fills the catalog rows for that provider: a field is assigned only when the row lacks it entirely.

- **Provider argument**: a config discovery target id, or a native provider id (models.dev rows with no config entry — the command learns these from the live catalog). With no argument the command first infers the provider from the session's **active model** (read through the session surface); if that resolves to a known provider — a config target or a native one — only that provider is merged. Otherwise (headless invocation, unreadable or unset model, unknown provider) it falls back to merging all config targets. Unknown ids get a sanitized ack listing both kinds.
- **Native providers**: the poll target is synthesized from the public models.dev registry (base URL, API-key env hint, integration id from the catalog record) and uses the same credential chain as normal polling (config `apiKey` → `apiKeyEnv` → credential store). The registry is fetched once per process and cached.
- **Effort join**: when a provider's own `/models` response is bare (ids only) but other providers in the models.dev registry define reasoning efforts for the same model ids, those effort variants fill the row's missing `variants` (first non-empty definition wins; existing fields, including a toggle, are never touched). When the provider's own models.dev entry declares a reasoning toggle without effort levels (an explicit no-effort statement), the join is suppressed for that provider — the merge ack says so explicitly.
- **Persistence + re-apply**: the ids touched per provider are recorded in the state file (`mergedModelIds`, a v2-additive field; older files load as empty) and re-applied on restart when the catalog replays.
- **Config-declared models are skipped**: the host's config plugin re-assigns hand-configured `models` entries after plugin transforms, so merging those rows is futile — config wins by host design. Config-side variant persistence is a follow-up.
- **Seeing the result**: the TUI caches the resolved model at selection time — reopen the model picker after a merge to see new efforts.

## Experiential Labs catalog enrichment

The `explabs` gateway (base URL host `api.experientiallabs.ai`) publishes a bare `/v1/models` listing; its public, keyless catalog at `https://api.experientiallabs.ai/api/models` carries per-route reasoning efforts. With the provider's explicit `modelsDiscovery: { "enrich": true }` and no `models` block, the plugin reads that catalog and enriches the discovered ids by exact string equality between the gateway id and the catalog's `model.slug`.

**First default route only.** For each catalog entry, only the providers[] row whose `id` equals `default_provider_ids[0]` is read. Second defaults, non-default routes, and other providers' rows are never consulted — even when they advertise efforts — so no level is ever borrowed from a route the gateway does not select.

**Three classification outcomes** (measured 2026-09-30 over all 297 cached gateway ids: 156 positive, 137 explicit-deny, 4 unknown):

| Class | Condition on the declared default route | Effect |
| --- | --- | --- |
| Positive | active, `routable !== false`, non-empty `supported_reasoning_efforts` string array | efforts become `variants` |
| Explicit deny | a resolved route that says `supports_reasoning: false` (all 137 live denies are this case), or an empty efforts array, or an inactive/unroutable route | `reasoningDenied` marker: models.dev join variants are suppressed in automatic cycles, merge presses, and restart replays |
| Unknown | no default route id, an unmatched route id, or no `supports_reasoning`/`supported_reasoning_efforts` statement (including `supports_reasoning: true` with the list absent) | no marker, no map entry: merge keeps its "fill missing fields" behavior with candidate join values |

The 4 unknown ids are `grok-4.20`, `grok-4.20-non-reasoning`, `grok-build-0.1`, and `mimo-v2.6-pro`. The other four mimo models are positive on their first default routes: `mimo-v2.5` (`none, low, medium, high`), `mimo-v2.5-pro` (7 levels), `mimo-v2.6-flash` (`medium`), `mimo-v2.6-pro-ultraspeed` (`medium`). This feature does not "restore" or "solve" MiMo efforts in general: `mimo-v2.6-pro`'s wally primary route is active and routable but publishes no capability keys, so its variants stay empty automatically — the disabled `experiential_cloud` route advertising `medium` is non-default and is never read. An explicit merge press may still offer models.dev candidates for it (see below).

**Candidates vs gateway-verified.** Merge gap-fill values that come from the models.dev registry join are candidates only (provenance `join`): the plugin has no evidence the gateway accepts those effort names, and they are never labeled gateway-verified or confirmed. A `provider-rich` value is what the provider's own response or catalog stated.

**Bounds.** One keyless catalog GET per eligible cycle (never per model): no `Authorization`, `Cookie`, or provider headers; 20 s timeout per request; at most 2 attempts per request; pages of 1000 with a hard 10-page cap; strict shape validation. A failed catalog fetch keeps the last good map and never fails the models poll.

**Request economics** (measured 2026-09-30: one catalog page = 4,247,183 B; the endpoint publishes no Cache-Control/ETag/Last-Modified/rate-limit headers, so conditional requests are not used and every GET is a full origin transfer):

- Success TTL: 24 h (86,400 s) by default, independent of `cacheFor` and the models poll cadence → 1 GET/day ≈ 4.25 MB/day per provider.
- Env override `OPENCODE_MODELS_DISCOVERY_EXPERIENTIAL_CATALOG_TTL_SECONDS` with a 900 s floor → worst case 96 GETs/day ≈ 408 MB/day.
- Pathological page cap: ≤10 pages ⇒ ≤42.5 MB per full fetch.
- Failure backoff: a failed fetch makes the endpoint ineligible for 1 h ⇒ ≤24 retry rounds/day, ≤48 request attempts/day (2 attempts per round) ⇒ ≈204 MB/day only if every failed response still transferred a full page (error responses and network failures transfer little or nothing).
- `models-discovery-rescan` (force mode) is the only TTL bypass: 1 explicit fetch. The merge command respects the TTL and reuses the cached map, and automatic polls never bypass.
- Restart: the TTL is process-local, so a restart triggers at most one refetch; enriched models (efforts and deny markers) rehydrate from the state file, so a restart inside the TTL replays them without catalog data.
- No published rate ceiling was found (no rate-limit headers, no 429, no docs statement): the defaults above are the only accepted load bound.

**Acceptance seam.** `OPENCODE_MODELS_DISCOVERY_EXPERIENTIAL_CATALOG_URL` redirects the catalog fetch, but only when its host[:port] equals the provider base URL's host[:port]; it is never used to reach a different origin. The host gate is exact and case-insensitive (`api.experientiallabs.ai` only — `apiexperientiallabs.ai`, `experientiallabs.ai`, `api.experientiallabs.ai.evil.example`, and `api.experientiallabs-ai.com` do not match).

## TUI shortcut (experimental)

The TUI half (`tui.tsx`) turns the otherwise-dead `Ctrl+T` variant cycle into a discovery trigger on models that have no variants. It auto-loads from the ordinary config `plugins` registration — a plugin with a server entrypoint carries its TUI half into the interactive TUI (verified on opencode v2.0.19). `~/.config/opencode/cli.json` is only the load path for TUI-only plugins — plugins with no server entrypoint (earlier probe evidence):

```jsonc
{ "plugins": ["/absolute/path/to/opencode-v2-model-discovery"] }
```

- **Any variants exist** — `variant.list()` returns every variant, not only reasoning efforts, so any non-empty list delegates conservatively to the native variant cycle; the shortcut arms only on a variant-less model.
- **No variants, first press** — a warning toast: `No reasoning efforts exist for this model. Press Ctrl+T again to trigger discovery.` This arms a 5-second window; a model or session change resets the pending state.
- **Second press within 5 s (same model, same session)** — runs `/models-discovery-merge <provider>` in that session and confirms `Discovery merge started for <provider>.` A 5-second cooldown then blocks accidental repeated triggers.
- **No open chat session** — server commands need an open session, so even the first press warns to open one first; nothing is armed and the "press again" hint is never shown.

Limitations: no completion event reaches the TUI — reopen the model picker after a merge to see the new efforts. Merged effort levels are candidate metadata (provider `/models` payload or models.dev join) — the merge does not validate that the gateway accepts those efforts.

## Limitations

- opencode v2 line only (beta through stable 2.x); one build spans them via
  dual-surface catalog resolution — `ctx.model.transform` (v2.0.4+ split) with
  fallback to `ctx.catalog.transform` (beta → v2.0.3). A runtime that removes
  both surfaces degrades to poll-only mode (discovery + state + rescan keep
  running) with a loud warn, never a silent abort. Pin a commit for stability.
- Enrichment quality depends on the provider — bare `/models` listings fall back to name-only catalog enrichment.
- `parametersPath` endpoints (e.g. Bifrost's `/api/models/parameters`) are management endpoints and may be RBAC-protected; without permission models keep join/name-only enrichment.
- Merge cannot verify that a provider's chat API actually accepts effort parameters — it only fills the catalog fields; a request-time rejection is possible and not detectable from `/models`.
- A model that vanishes from the provider's list keeps its gap-filled fields (fill-only semantics; removal cleanup only covers plugin-owned models).
- If the host maps a provider's reasoning toggle into an existing `variants` value, merge will not add efforts to that row — it never overwrites.
- The merge command registers only when at least one discovery target is configured; a zero-target setup is a no-op plugin.
- A provider whose own API documents no effort parameter (thinking toggle only — e.g. xiaomi's chat completions) receives no imported effort variants: models.dev effort lists under other providers are gateway-side mappings, not native capabilities, and the provider's chat API may reject `reasoning_effort` requests.

## Development

```bash
bun install
bun test            # 180 tests
bun run typecheck
bun run smoke
```

See [`opencode.example.jsonc`](./opencode.example.jsonc) for a fully commented example config.

## License

MIT
