---
name: qoder-quota
description: Check Qoder credit balance, quota exhaustion, models, catalog provenance and account/credential info. Use when the user asks about Qoder 配额/额度/余额/credits, which models exist and what they cost, why a model is missing, or which account/credential is in use.
---

# Qoder Quota & Account

Two surfaces, one implementation:

1. **Native tools (primary)** — the `opencode-qoder` plugin registers read-only
   tools via `Hooks.tool`. Prefer these inside a conversation: they run in the
   plugin's own process, reuse its warm catalog state, and are self-describing.
2. **Shell script (fallback)** — `scripts/qoder-quota.mjs`, for contexts where
   no opencode session is running (cron, heartbeat, a bare shell). It reads the
   same credential layers; see its `--help`.

Both answer the same questions, so pick by context, not by habit. Neither prints
a token.

## Tools

| Tool           | Answers                                                          |
| -------------- | ---------------------------------------------------------------- |
| `qoder_quota`  | 剩余额度：plan / add-on / org package 各桶、总计、是否耗尽、续期日 |
| `qoder_account`| 当前凭证属于哪个账户（姓名、邮箱、组织）                           |
| `qoder_models` | 全部模型：倍率、上下文/输入/输出上限、思考档位、Unavailable 标记    |
| `qoder_model`  | 单个模型详情（参数 `id`，如 `cmodel`）                             |
| `qoder_catalog`| 模型表从哪来（qoder/cache/fallback）、何时刷新、缓存路径、排障      |
| `qoder_auth`   | 凭证走的哪一层、何时过期 —— 只报 shape，永不回显 token             |
| `qoder_pat_list`| 列出所有存储的 PAT（多账户切换）                                  |
| `qoder_pat_switch`| 切换到指定 PAT（参数 `id`）                                    |
| `qoder_pat_add` | 添加新 PAT（参数 `pat`, `label`, `email`）                       |
| `qoder_pat_remove`| 删除指定 PAT（参数 `id`）                                      |
| `qoder_tier_list`| 各模型的可选上下文档位 + 当前选中档                              |
| `qoder_tier_switch`| 切换模型上下文档位（参数 `model`, `tier`；省略 `tier` 恢复默认）|

Call them directly with no arguments unless noted. Results arrive as text with
the structured payload in metadata.

## Multi-PAT Account Switching

Store multiple Qoder accounts and switch between them at runtime. PATs are
persisted to `~/.config/opencode/qoder-pats.json` (honours `XDG_CONFIG_HOME`).

**Workflow:**
1. Add accounts: `qoder_pat_add(pat="pt-...", label="Work", email="work@example.com")`
2. List accounts: `qoder_pat_list()` — shows which is active
3. Switch: `qoder_pat_switch(id="pat_abc123")` — subsequent requests use that PAT
4. Remove: `qoder_pat_remove(id="pat_abc123")`

**Credential precedence** (highest first):
1. `personalAccessToken` option (explicit, rare)
2. Connection credential (`/connect qoder`)
3. Plugin options `apiKey` (from opencode.json)
4. Shared apiKey (legacy → v2 bridge)
5. **Active PAT from pat-store** ← new
6. Environment variables (`QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT`)

The active PAT is used automatically by all requests. Switching is instant — no
restart needed.

## Subagent Model Optimization

The plugin configures opencode's subagents to use free/cheap models by default,
saving quota for the main coding agent. Verified against opencode 1.18.29
built-in agents (config section is `agent`, singular; `agents` is only a compat
alias):

| Agent        | Default Model | Purpose                          |
|--------------|---------------|----------------------------------|
| main (build) | user's choice | Main coding agent                |
| `plan`       | `lite`        | Explores code, writes plans      |
| `general`    | `lite`        | Task-tool subagents (multi-step) |
| `explore`    | `lite`        | Read-only code search            |
| `title`      | `lite`        | Generates session titles         |
| `compaction` | `lite`        | Compresses conversation history  |

Model resolution per message: `message.model ?? agent.config.model ?? session's
current model`. An agent with a configured model is pinned to it; agents without
one (e.g. the main agent) follow the user's model picker.

**Compaction caveat:** the compaction agent receives the WHOLE conversation.
`lite` caps at 200k, so sessions run above 200k (`performance` 272k, `kmodel`
256k, or a raised context tier like cmodel @ 1M) cannot be compacted by it.
`qoder_tier_switch` warns when raising a model above 200k. If you live above
200k, override `agent.compaction` in `opencode.json` or remove the pin (unset
agents inherit the session model, which always fits by definition).

**Override:** Set `agent.*` (singular) in `opencode.json` to use different
models. The plugin only fills gaps — an entry under `agent.X` (or the legacy
`agents.X` alias) always wins over the plugin's default:

```json
{
  "agent": {
    "compaction": { "model": "qoder/cmodel" },
    "general": { "model": "qoder/efficient" }
  }
}
```

Note: `reasoningEffort` is not an agent config field; per-request reasoning is a
model `variant` (and `lite` publishes none). Agent fields are `{model, variant,
prompt, description, mode, ...}`.

**Quota impact:** Subagents (plan/general/explore/title/compaction) use `lite`
which is free (0x multiplier). Only the main agent bills against quota. This
can reduce quota usage by 50-80% for typical sessions.

## Reading the numbers

- Report **each bucket separately**. A drained plan quota with a large org
  package is not "out of credit", and the two are billed differently.
- `Total left` is the sum of every bucket that answered; say 合计 when quoting it.
- `org package` showing "no ceiling set" means `cap: -1` upstream — unlimited,
  not zero. Never print `remaining / -1`.
- `Plan usage` is a fraction over the **plan bucket only** (0.01 = 1%). It is
  not an exhaustion signal; the plugin never treats it as one.
- `Unavailable` in a model name means credits are drained and that model is paid
  (multiplier > 0). Free models stay usable.
- `Renews` / `Usable until` are UTC.

## Failures that are not failures

- A quota tool error naming credentials means the **tool process** saw no
  credential layer. Check `qoder_auth` first: it lists every layer by shape
  (`pat`, `opaque(27)`, `absent`). `absent` everywhere = set
  `QODER_PERSONAL_ACCESS_TOKEN` or run `/connect qoder`.
- `qoder_catalog` showing `source=fallback` means discovery never succeeded; its
  `last error` line says why. `source=cache` is healthy — that is the last
  known-good live table, seeded from disk.
- A model id that resolves to "not found" reports the fallback model's limits
  rather than silently re-keying; do not quote those numbers as the requested
  model's.

## Cost of asking

Nothing. Verified 2026-09-08 with a controlled experiment: ten consecutive
quota reads with no model traffic in between left `used` bit-identical. The
usage endpoint is unmetered -- qodercli itself polls it on a timer, which would
drain an account daily if reading it cost anything.

What DOES move the counters is model traffic: chat turns through Qoder models
bill their multiplier against plan quota first, then the org package. When the
numbers drift between two reads, look for model usage in the interim, not at
these tools.

## Script fallback

```bash
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs            # human summary
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --json     # structured
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --refresh  # skip cached job token
```

Exit `0` = data fetched (credits may still be spent); exit `1` = nothing usable,
with the reason on stderr. Read the stderr; never report a number you did not
get.

## Context Tier Switching

Qoder's gateway serves most models at several selectable context tiers
(`context_config`, e.g. Cantus 200K default / 1M). Requests pick a tier via
`parameters.context_length` (a token count) — the same field qodercli sends
from its window picker. Without it, the gateway applies the DEFAULT tier,
which is what the model's advertised context window reflects.

**Workflow:**
1. `qoder_tier_list()` — see each model's advertised tiers and the current selection
2. `qoder_tier_switch(model="cmodel", tier=1000000)` — select a tier
3. `qoder_tier_switch(model="cmodel")` — omit `tier` to restore the default
4. After switching, **re-select the model** in the picker so the session picks
   up the new limits; if the compaction threshold did not move, restart opencode

**Validation:** the tier must be EXACTLY one of the model's advertised tiers
(mirrors qodercli's `qq()` validator). The tool rejects anything else and
lists the accepted values.

**Why limits must move with the tier:** opencode's auto-compaction threshold
derives from the model's registered `limit.input`. Selecting the 1M tier
without moving the limits would leave opencode compacting at ~180k while the
gateway accepts ~980k — the 1M would never be used. The plugin re-registers
the model's limits at the selected tier automatically (same model id, same
name; only the numbers behind the picker change).

**Billing caveat:** higher tiers may bill differently — check `qoder_quota`
after a long session on a non-default tier.
