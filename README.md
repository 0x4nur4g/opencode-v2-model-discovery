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
| `modelsDiscovery.pollTimeoutSeconds` | provider | `20` | Per-request fetch timeout; min `5`. |
| `modelsDiscovery.parametersPath` | provider | off | Per-model parameters endpoint for providers whose `/models` lacks effort data (e.g. `/api/models/parameters`). |
| `intervalSeconds` | plugin / env | `300` | Poll interval for every target; min `15`. |
| `cacheFor` | plugin / env | off | Success-only cache TTL; min `60`. |
| `pollTimeoutSeconds` | plugin / env | `20` | Fetch timeout; min `5`. |
| `parametersPath` | plugin / env | off | Global fallback parameters endpoint. |
| `providers` | plugin | — | Manual targets: `{ id, baseURL, apiKeyEnv, headers, filter, integrationID, enabled }`. `enabled: false` blocks a provider id entirely. |
| `filter` | provider / manual target | — | Only inject model ids containing this substring. |
| `apiKey` | provider | — | Literal or `{env:VAR}` interpolation; sent as `Authorization: Bearer …`. |
| `apiKeyEnv` | provider / manual target | — | Environment variable holding the key. |
| `headers` | provider / manual target | — | Extra headers on every request. |
| `OPENCODE_MODELS_DISCOVERY_INTERVAL_SECONDS` | env | — | Overrides `intervalSeconds`. |
| `OPENCODE_MODELS_DISCOVERY_CACHE_FOR_SECONDS` | env | — | Overrides `cacheFor`. |
| `OPENCODE_MODELS_DISCOVERY_POLL_TIMEOUT_SECONDS` | env | — | Overrides `pollTimeoutSeconds`. |
| `OPENCODE_MODELS_DISCOVERY_PARAMETERS_PATH` | env | — | Overrides `parametersPath`. |
| `OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED` | env | — | Default on/off when a provider has no explicit `modelsDiscovery` flag. |
| `OPENCODE_MODELS_DISCOVERY_STATE_FILE` | env | — | Override the state file path (see below). |

Authentication per poll, in order: `apiKeyEnv` environment value → config `apiKey` (literal or `{env:VAR}`) → OpenCode credential store (`opencode auth login`). Keys are never logged; an unset `{env:VAR}` reference polls without auth and warns once. One credential per provider id — multiple store keys under one provider are not unioned (see `docs/opencode-v2-plugin-credential-resolution.md`).

## What gets enriched

With `{"enrich": true}`, provider metadata maps onto opencode's catalog schema. Precedence is per field: provider-rich data wins each field it supplies, and the opencode catalog join fills the rest.

| Field | Sources | Notes |
| --- | --- | --- |
| `variants` | `reasoning.supported_efforts`, `reasoning_options`, `additional_attributes.reasoning_efforts` (CSV), explicit `variants` | Mapped to `variants[].settings.reasoningEffort`. Efforts are never inferred from a bare `reasoning: true`. |
| `limit` | `context_length`, `max_input_tokens`, `max_output_tokens`, `max_completion_tokens` | Needs context + output from the provider; join fills the rest. |
| `capabilities` | `modalities` / `architecture` input-output modalities, `tools` | Same per-field merge. |

An optional `parametersPath` endpoint (e.g. Bifrost's `/api/models/parameters`) backfills models that still lack effort variants, one lazy per-model fetch: `reasoning_effort_levels` → variants, `max_tokens` / `max_input_tokens` / `max_output_tokens` → limit, `supported_modalities` / `supports_function_calling` → capabilities. Failures skip that model for the cycle and never block the rest of the poll.

## Behavior

- Failed polls (timeout, non-2xx, bad JSON) keep the provider's last-good models — a transient outage never empties the catalog.
- A successful empty poll removes previously discovered models; models you registered yourself are never touched.
- Your own model names are preserved — the plugin only names a model when none exists.
- The `models-discovery-rescan` command posts session acknowledgements: a "started" message immediately, then a sanitized summary (`N model(s) across M provider(s)`, plus any providers that failed and kept their last known models) when the cycle completes. Invocations without a session stay silent.
- `cacheFor` gates on the last **successful** poll; caching never delays recovery. The `models-discovery-rescan` command bypasses interval and TTL.
- Config edits apply via the config-file watch (~0.5 s debounce) or the next poll cycle.
- Refreshes are serialized with a generation guard: a slow poll can't commit stale results over a newer one.

## State file

The plugin snapshots poll clocks and counts to `${XDG_STATE_HOME:-~/.local/state}/opencode/model-discovery/state.json` so you can `cat` it to see what happened; override the path with `OPENCODE_MODELS_DISCOVERY_STATE_FILE`.

```json
{
  "version": 1,
  "providers": {
    "bifrost": {
      "lastSuccessAt": "2026-09-09T10:00:00.000Z",
      "lastPolledAt": "2026-09-09T10:00:00.000Z",
      "modelCount": 248,
      "cacheForSeconds": 86400,
      "lastTrigger": "poll"
    }
  },
  "lastRescanAt": "2026-09-09T10:05:00.000Z"
}
```

- Written once per refresh cycle that polled any provider, after the catalog commit succeeds; the `models-discovery-rescan` command also stamps `lastRescanAt`.
- `lastSuccessAt` is success-only: failed polls never advance it, so `cacheFor` semantics survive on disk.
- At startup the file seeds the clocks — a provider inside its `cacheFor` TTL stays cached across restarts.
- Atomic write (temp file + rename); file mode `0600`, directory `0700`. A write failure only warns.
- Never stores credentials, URLs, or model ids — timestamps, counts, trigger, and TTL only.

## Limitations

- opencode v2 beta line only; the runtime moves fast, so pin a commit for stability.
- Enrichment quality depends on the provider — bare `/models` listings fall back to name-only catalog enrichment.
- `parametersPath` endpoints (e.g. Bifrost's `/api/models/parameters`) are management endpoints and may be RBAC-protected; without permission models keep join/name-only enrichment.

## Development

```bash
bun install
bun test            # 91 tests
bun run typecheck
bun run smoke
```

See [`opencode.example.jsonc`](./opencode.example.jsonc) for a fully commented example config.

## License

MIT
