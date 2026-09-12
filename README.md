# opencode-qoder

English | [简体中文](README.zh-CN.md)

Qoder Global provider plugin for [opencode](https://opencode.ai/). Ported from the global-only pieces of `pi-provider-qoder`: PAT exchange, COSY request signing, Qoder body encoding, chat SSE parsing, reasoning, image input, and tool calls.

Qoder China endpoints and model aliases are intentionally not included.

## Build

```bash
pnpm install
pnpm build
```

## Installation

Add the plugin to `opencode.json`, or adjust the path for your config location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qoder"],
  "model": "qoder/auto"
}
```

The plugin registers provider `qoder` and bundles 17 models -- see [Models](#models).

## Models

The bundled table ships these ids. The first five are Qoder's own tier aliases rather than upstream brands; the rest map to their upstream model names:

| id | Upstream model |
| --- | --- |
| `auto` | Auto (gateway picks) |
| `ultimate` | Ultimate |
| `performance` | Performance |
| `efficient` | Efficient |
| `lite` | Lite |
| `qmodel_38max` | Qwen3.8-Max |
| `qfmodel` | Qwen3.8-Flash |
| `qmodel_latest` | Qwen3.7-Max |
| `qmodel` | Qwen3.7-Plus |
| `kmodel_latest` | Kimi-K3 |
| `kmodel` | Kimi-K2.7-Code |
| `gmodel` | GLM-5.3 |
| `gfmodel` | GLM-5.3-Flash |
| `dmodel` | DeepSeek-V4-Pro |
| `dfmodel` | DeepSeek-V4-Flash |
| `mmodel` | MiniMax-M3 |
| `cmodel` | Cantus |

Credit multipliers, context tiers and thinking efforts come from live discovery (next section) and move with Qoder's pricing; the bundled table carries none of them. The previously listed `qmodel_preview` and `gm51model` are retired upstream and no longer bundled.

## Model discovery

The live model list is fetched at startup and refreshed every 15 minutes; when it changes, opencode's catalog reloads automatically. The last live list is cached at `~/.cache/opencode/opencode-qoder-models.json` (honors `XDG_CACHE_HOME`) across restarts. If both live and cache are unavailable, a static fallback table is used.

The static fallback is a prefab JSON file shipped as `models.json` next to the plugin code, holding the current advertised models only. To edit it for a special case, drop your own copy at `~/.config/opencode/qoder-models.json` (honors `XDG_CONFIG_HOME`), or point `QODER_STATIC_MODELS` at any path. Precedence is env → user file → shipped file. Each is a JSON array (or `{"models": [...]}`) of entries with `id`, `name`, `reasoning`, `supportsEffort`, `input`, `contextWindow`, `maxTokens` (and optional `inputWindow` ≤ `contextWindow`); invalid entries are dropped individually so one typo never blanks the table. The live list is authoritative: models it stops advertising are hidden even when offline, so a manually added id shows up only in the fallback path, never overriding a live answer.

Models advertising reasoning effort levels expose one variant per effort (e.g. `high`, `low`, `max` on `kmodel_latest`), selectable in opencode's model picker.

Model names carry Qoder's credit multiplier, e.g. `(0.5x)`. Once credits run out, paid models gain an `Unavailable` suffix (e.g. `(0.5x, Unavailable)`) but stay selectable; zero-multiplier models are exempt. Both come from the live list, so neither appears while the static fallback is in use.

| Variable | Purpose |
| --- | --- |
| `QODER_DISABLE_MODEL_DISCOVERY` | Set to `1`, `true`, or `yes` to disable discovery |
| `QODER_MODEL_LIST_URL` | Override the model list endpoint |
| `QODER_MODEL_CACHE_SECONDS` | Catalog TTL in seconds (default: 3600) |
| `QODER_MODEL_DISK_CACHE` | Override the disk cache path |
| `QODER_STATIC_MODELS` | Path to a custom static fallback table (JSON) |
| `OPENCODE_QODER_LOG_FILE` | Append diagnostics (credit quota, catalog refreshes) to this path. Unset by default, which logs nothing |

## Tools and skill

Once loaded, the plugin registers read-only tools that answer account questions directly in the conversation:

| Tool | Answers |
| --- | --- |
| `qoder_quota` | Remaining credits per bucket (plan / add-on / org package), total, exhaustion flag, renewal date |
| `qoder_account` | The profile the current credential belongs to (name, email, organisation) |
| `qoder_models` | Every model offered: multiplier, limits, thinking efforts, `Unavailable` marks |
| `qoder_model` | One model's details by `id`; an unknown id resolves to the fallback model and says so |
| `qoder_catalog` | Where the model table came from (live / cache / fallback), freshness, cache path |
| `qoder_auth` | Which credential layer is in effect and what it resolves to -- shape only, never the token value |
| `qoder_tier_list` | See each model's advertised tiers, this conversation's tier, and the active routing policy |
| `qoder_tier_switch` | Switch the current conversation's context tier (model + tier; omit tier to restore default) |
| `qoder_routing_policy` | View or edit the lite→qfmodel auto-escalation policy (no params = show) |

Reading quota is unmetered: ten consecutive reads leave the usage counters unchanged (verified 2026-09-08). If the numbers move between reads, that is model usage, not these tools.

The repo also ships the `qoder-quota` skill (`skills/qoder-quota/`) with a standalone script for contexts without a running opencode session (cron, a bare shell):

```bash
node skills/qoder-quota/scripts/qoder-quota.mjs            # human-readable
node skills/qoder-quota/scripts/qoder-quota.mjs --json     # structured
node skills/qoder-quota/scripts/qoder-quota.mjs --refresh  # skip the cached job token
```

The script resolves credentials in the same order the plugin does: `--pat`/`--token`, then `QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT`, then `provider.qoder.options.apiKey` in `opencode.jsonc` (expanding `{file:...}`), then `~/.qoderkey_pat`, then opencode's own `auth.json`.

## Authenticate

Use a Qoder Personal Access Token (`pt-...`). It is exchanged for a short-lived job token automatically before requests.

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
opencode
```

`QODER_PAT` is accepted as an alias.

Or run opencode's auth flow:

```text
/connect qoder
```

Choose `Personal Access Token` and paste the PAT.

After changing the plugin config, quit and restart opencode. Plugins and provider config are loaded at startup.

## Multiple accounts

Several Qoder accounts can be stored at once and switched at runtime. The store is `~/.config/opencode/qoder-pats.json` (honours `XDG_CONFIG_HOME`), written `0600`; one entry is active and signs every request until you switch. Manage it from the conversation with `qoder_pat_add`, `qoder_pat_list`, `qoder_pat_switch`, `qoder_pat_remove`.

To seed the store without any tool call (a fresh box, a CI runner), set the import variable to a comma- or semicolon-separated list:

```bash
export OPENCODE_QODER_PAT="pt-aaa,pt-bbb"
opencode
```

This is a one-time **import**, not a lookup layer: at startup each unseen `pt-` segment is added (the first activates an empty store), after which the store — not the variable — authenticates requests. `OPENCODE_QODER_PAT` is deliberately separate from `QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT`, so it never collides with the official Qoder CLI (those stay single-PAT, unchanged). Unset it once imported so the tokens do not linger in child-process environments.

### Recovery when no chat works

If the active credential is revoked or its account lapsed, the in-chat tools cannot save you: they need a working conversation to run in, and every model — including free `lite` (`x0` waives credits, not authentication) — is refused. The `qoder-quota` skill script reads the same store from a bare shell:

```bash
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --pats
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --use-pat=Work   # id or label
```

`--pats` probes each stored PAT against the live gateway and classifies it (ALIVE / EXHAUSTED / DEAD / ACCOUNT-INACTIVE / UNREACHABLE); `--use-pat` flips `active` to a healthy entry, refusing an unhealthy one unless `--force`. A running opencode reloads the store by file mtime, so the switch takes effect on the next request — no restart.

### What a dead credential costs you

The tier system can route an over-budget *conversation* to free `lite`, but only if some credential authenticates. Two failure shapes:

| What broke | Who recovers |
| --- | --- |
| Exchange token (job token) revoked/expired | the plugin renews it automatically |
| **The PAT itself** revoked, or the account's subscription lapsed | only you — `--use-pat` to a healthy backup, or `qoder_pat_add` / re-`/connect` a new PAT |

An `ACCOUNT-INACTIVE` verdict means the whole account is down, so a backup on the *same* account won't help; seed a PAT for a different one with `OPENCODE_QODER_PAT`. Switching to a healthy backup is the entire recovery — `--use-pat` flips the store, the next request picks it up, and you keep working in the now-live chat.
