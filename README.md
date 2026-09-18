# opencode-qoder

English | [简体中文](README.zh-CN.md)

Qoder provider plugin for [opencode](https://opencode.ai/). Ported from `pi-provider-qoder`: PAT exchange, COSY request signing, Qoder body encoding, chat SSE parsing, reasoning, image input, and tool calls.

The international site (`qoder.sh`) is the verified deployment. The China site
(`qoder.com.cn`) has code support and a second provider instance, but its endpoints come
from community projects and **have never been exercised against a real CN account** --
treat it as experimental. (An international PAT is rejected by the CN hosts, so a CN run
that *succeeds* means the region never reached the request.)
See [Both regions at once](#both-regions-at-once).

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

### Both regions at once

> **Experimental.** The CN endpoints are unverified -- see the note at the top. Adding this
> entry is safe for the international provider (they are fully independent), but the CN
> provider is not known to work.

Add a second entry naming the CN provider. The two instances are independent: separate
credential stores, separate model catalogs, separate tier selections.

```jsonc
{
  "plugin": [
    ["opencode-qoder"],                                     // provider "qoder"
    ["opencode-qoder", { "providerID": "qoder-cn",          // provider "qoder-cn"
                         "region": "cn" }]
  ]
}
```

Load plugins from `~/.config/opencode/plugin/` instead? Drop in two shims that use the
exported factory:

```js
// ~/.config/opencode/plugin/qoder.js
import { definePlugin } from "opencode-qoder";
export default definePlugin("global");

// ~/.config/opencode/plugin/qoder-cn.js
import { definePlugin } from "opencode-qoder";
export default definePlugin("cn");
```

Then reference models as `qoder/auto` and `qoder-cn/auto`. The quota script takes
`--region=cn` to read the CN store:

```bash
node qoder-quota.mjs --resolve --region=cn
```

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

The live model list is fetched at startup and then re-fetched when the catalog TTL lapses (default: 1 hour; `QODER_MODEL_CACHE_SECONDS`) -- a 15-minute timer runs that check, so the TTL is the effective refresh interval, not the timer. When the list changes, opencode's catalog reloads automatically. The last live list is cached at `~/.cache/opencode/opencode-qoder-models.json` (honors `XDG_CACHE_HOME`) across restarts. If both live and cache are unavailable, a static fallback table is used.

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
| `qoder_tier_switch` | Switch the current conversation's context tier (`model` + `tier`; `model: "*"` applies to every model advertising the tier; omit `tier` to restore default) |
| `qoder_routing_policy` | View or edit the lite→qfmodel auto-escalation policy (no params = show) |
| `qoder_campaign` | Today's promotional check-in as the server describes it: window, status, reward (read-only; `all` sweeps stored PATs) |
| `qoder_claim` | The claim POST itself — see [Daily campaign claim](#daily-campaign-claim) |

Reading quota is unmetered: ten consecutive reads leave the usage counters unchanged (verified 2026-09-08). If the numbers move between reads, that is model usage, not these tools.

The plugin also bundles the `qoder-quota` skill (`skills/qoder-quota/`) and registers it automatically on load -- installing the plugin installs the skill, with no manual copy step (`QODER_DISABLE_BUNDLED_SKILL=1` opts out). The skill's standalone script also works in contexts without a running opencode session (cron, a bare shell):

```bash
node skills/qoder-quota/scripts/qoder-quota.mjs            # human-readable
node skills/qoder-quota/scripts/qoder-quota.mjs --json     # structured
node skills/qoder-quota/scripts/qoder-quota.mjs --resolve  # which credential layer answers, offline
```

The script is a thin wrapper over the plugin's compiled modules, so it resolves
credentials with exactly the plugin's precedence: `--pat`/`--token` (an explicit
CLI act), then the store's switched-to entry, then opencode's `auth.json`, the
configured `apiKey`, the key file, the store's auto-active entry, and the
environment (`QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT`) last.

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

The plugin owns its credential file: `~/.qoderkey_env` (override with the provider option `keyFile` or the env var `OPENCODE_QODER_KEY_FILE`; `none` disables the layer). No `apiKey: "{file:...}"` indirection in `opencode.jsonc` is needed — the plugin reads the file itself, once at startup and every 60 seconds. The same grammar decides the file's role:

- **A lone token** → your credential. It signs exactly like the old `{file:...}` option did and outranks everything below an explicit switch.
- **A list** (`,`/`;`/newline-separated, or the `OPENCODE_QODER_PAT=...` assignment form) → a **seed import**: each unseen `pt-` segment is added to the store (the first activates an empty store), after which the store — not the file — authenticates requests.
- **A shell env file** (`export OPENCODE_QODER_PAT="pt-a,pt-b"` / `export QODER_PERSONAL_ACCESS_TOKEN="pt-a"`) → the variable's value is extracted and treated by the two rules above. `OPENCODE_QODER_PAT` wins when both are present; so a sourced shell snippet and a bare token file both work as the same file.

Detection is mtime-based, so the steady cost of the periodic check is one stat, and editing the file lands on the next tick without a restart.

The store is `~/.config/opencode/qoder-pats.json` (honours `XDG_CONFIG_HOME`), written `0600`. It is only ever created by real input — a list-form key file, the env import, or `qoder_pat_add` — never by placeholder data. Manage it from the conversation with `qoder_pat_add`, `qoder_pat_list`, `qoder_pat_switch`, `qoder_pat_remove`.

To seed it without any file at all (a fresh box, a CI runner), set the import variable to a comma- or semicolon-separated list:

```bash
export OPENCODE_QODER_PAT="pt-aaa,pt-bbb"
opencode
```

This is likewise a one-time **import**, not a lookup layer. `OPENCODE_QODER_PAT` is deliberately separate from `QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT`, so it never collides with the official Qoder CLI (those stay single-PAT, unchanged). Unset it once imported so the tokens do not linger in child-process environments.

### Who signs a request

Highest first:

| # | Layer | Where it comes from |
| --- | --- | --- |
| 1 | `personalAccessToken` option | provider config in `opencode.jsonc` |
| 2 | **Explicit selection** | `qoder_pat_switch <id>` — outranks all passive config until cleared |
| 3 | Connection credential / `apiKey` option | `/connect` or config; list-form values are skipped (they are importer input, not a bearer token) |
| 4 | Key-file lone token | `~/.qoderkey_env` holding exactly one token |
| 5 | Store active entry | auto-activated on first import; flipped by `qoder_pat_switch` / `--use-pat` |
| 6 | `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT` | env, unchanged from the official CLI |

The table encodes the compatibility rule: **a single key has the highest priority** (rows 1–4 beat the store, just as the old `{file:...}` config did) — but a **deliberate act outranks passive config**: after `qoder_pat_switch`, that choice signs everything even while the key file still holds a token. `qoder_pat_switch` with no id clears the selection and hands authority back to the file.

### Recovery when no chat works

If the active credential is revoked or its account lapsed, the in-chat tools cannot save you: they need a working conversation to run in, and every model — including free `lite` (`x0` waives credits, not authentication) — is refused. The `qoder-quota` skill script reads the same store from a bare shell. It ships inside the plugin package (`<plugin-dir>` = the checkout when developing, the opencode plugin cache dir once installed):

```bash
node <plugin-dir>/skills/qoder-quota/scripts/qoder-quota.mjs --pats
node <plugin-dir>/skills/qoder-quota/scripts/qoder-quota.mjs --use-pat=Work   # id or label
```

`--pats` probes each stored PAT against the live gateway and classifies it (ALIVE / EXHAUSTED / DEAD / ACCOUNT-INACTIVE / UNREACHABLE); `--use-pat` flips `active` to a healthy entry, refusing an unhealthy one unless `--force`. A running opencode reloads the store by file mtime, so the switch takes effect on the next request — no restart.

### What a dead credential costs you

The tier system can route an over-budget *conversation* to free `lite`, but only if some credential authenticates. Two failure shapes:

| What broke | Who recovers |
| --- | --- |
| Exchange token (job token) revoked/expired | the plugin renews it automatically |
| **The PAT itself** revoked, or the account's subscription lapsed | only you — `--use-pat` to a healthy backup, or `qoder_pat_add` / re-`/connect` a new PAT |

An `ACCOUNT-INACTIVE` verdict means the whole account is down, so a backup on the *same* account won't help; seed a PAT for a different one with `OPENCODE_QODER_PAT`. Switching to a healthy backup is the entire recovery — `--use-pat` flips the store, the next request picks it up, and you keep working in the now-live chat.

## Daily campaign claim

Qoder runs time-boxed marketing campaigns — usually a daily check-in worth credits — and its own CLI claims them through a server-pushed `/claim` command. The plugin drives the same two endpoints with nothing but a plain Bearer client: no remote code is fetched or executed, and the server stays the authority on eligibility and window (no 12:00 is hardcoded anywhere).

This is a **marketing surface, not part of the provider**. An activity can be withdrawn without notice, so it is built to fail quietly and to leave in one piece: `src/claim.ts` is a leaf — no module on the model, catalog or quota path imports it, and `src/__tests__/claim.test.ts` fails the build if that ever inverts.

| Tool | Behaviour |
| --- | --- |
| `qoder_campaign` | Read-only: what the server offers right now, the window, the status, the reward. `all: true` sweeps every stored PAT. |
| `qoder_claim` | The claim itself — an explicit mutation, `all: true` to sweep accounts. |

A 200 whose list is empty is the ordinary shape of "this activity is not for you right now", so it says exactly that and cools down for *nothing*: `showCampaign` was observed flapping while the daily window was still open, and sleeping on it would walk past the reward. Only a genuinely missing route earns the long cooldown (404/410 → 6 h, so a dead activity stops nagging the gateway); a transient 5xx gets 45 min, and a 409 reads as "outside the window", not "something broke". A public function here never throws — every failure comes back as a verdict.

The campaign skill (`skills-campaign/qoder-claim/`, exposed as `/qoder-claim`) registers only while the surface is enabled, so switching it off takes the command with it:

```bash
export OPENCODE_QODER_CLAIM=off   # 0 / off / false / none / disable / disabled, case-insensitive
```

Everything on the campaign path then reports itself switched off and sends no request; the rest of the plugin is untouched. To retire the activity permanently instead, delete `src/claim.ts`, its wiring in `src/index.ts`, and `skills-campaign/`.

For an unattended daily claim, the bundled script prints the recurring-job line for the machine it runs on, with node's and its own absolute paths already filled in — it prints only, you arm it:

```bash
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs           # claim for the active account
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs --status   # just ask what is offered
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs --all      # sweep every stored PAT
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs --schedule # cron / Task Scheduler line
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs --reset    # forget local cooldown state
```

```bash
node skills-campaign/qoder-claim/scripts/qoder-claim.mjs --json --all \
  | jq -r '.attempts[] | "\(.account)\t\(.outcome)\t\(.awarded // 0)"'
```

Exit `0` means the job ran — including "nothing to claim today" and "cooling down" — so a healthy schedule stays silent; `1` is a verdict needing a human; `2` means the kill switch is off while the schedule still fires, i.e. take the job down. Re-running is safe: a window already claimed from this machine is skipped. `~/.config/opencode/qoder-claim.json` (honours `XDG_CONFIG_HOME`) holds only that dedup record and cooldown state — a local courtesy, never the source of truth.

`--schedule` emits a crontab line on Linux/macOS and a PowerShell `Register-ScheduledTask` on Windows. Task Scheduler does not inherit your shell environment, so arm the Windows job with the credential reachable without one (a user-level variable, `auth.json`, or the key file) rather than relying on what you exported in the terminal you tested from.
