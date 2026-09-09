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

Call them directly with no arguments unless noted. Results arrive as text with
the structured payload in metadata.

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
