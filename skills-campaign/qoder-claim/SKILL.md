---
name: qoder-claim
description: Claim the Qoder daily campaign reward (the check-in / 签到 / daily credits that qodercli's /claim performs) and report what the server currently offers. Use when the user asks to claim, check in, sign in, 签到, 领积分, whether a daily reward exists, whether it was already claimed today, or wants the check-in to run on a schedule. Read-only first; the claim is an explicit mutation.
---

# Qoder Daily Claim (campaign)

A **marketing surface**, not part of the provider. Qoder delivers a time-boxed
campaign (usually a daily check-in worth some credits) and qodercli claims it
through a server-pushed `/claim` command. This skill performs the same claim
against the same endpoints, with the activity's ephemerality designed in: it can
be withdrawn at any moment and nothing here should break when it is.

Everything is server-authoritative. Eligibility, the window, and the reward come
from the campaign response — never from a clock or a hardcoded "12:00" in here.

## Two surfaces, one implementation

1. **Native tools (in a conversation)** — the plugin registers `qoder_campaign`
   (read-only) and `qoder_claim` (the mutation). Prefer these when opencode is
   running; they reuse the plugin's credential layers.
2. **Shell script (outside a conversation)** —
   `scripts/qoder-claim.mjs`, for cron, a Windows scheduled task, or a bare
   shell where
   no opencode session exists. It drives the same `dist/claim.js` the tools call,
   so the contract, the status ladder and the local markers are identical.
   `<skill-dir>` below is the directory holding this file.

Both answer the same questions. Neither prints a token.

## Commands

```
node <skill-dir>/scripts/qoder-claim.mjs            # claim for the active account
node <skill-dir>/scripts/qoder-claim.mjs --status   # read-only: what's on offer
node <skill-dir>/scripts/qoder-claim.mjs --all      # every stored PAT, one line each
node <skill-dir>/scripts/qoder-claim.mjs --json     # machine-readable verdicts
node <skill-dir>/scripts/qoder-claim.mjs --reset    # clear local cooldown markers
node <skill-dir>/scripts/qoder-claim.mjs --pat=pt-… # pin one account this run
```

Exit codes are cron-friendly:

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `0`  | Did its job — including "nothing on offer", "already claimed", and  |
|      | "cooldown" (the surface protecting itself is not an incident)       |
| `1`  | Needs a human: no credential, or an unknown / service-rejected      |
|      | verdict from the claim route                                        |
| `2`  | The feature is switched off by env while the caller still fired it  |
|      | — the activity was withdrawn, so take the timer down                |

A transient failure exits 1 on the run that hits it, and 0 on the suppressed
runs that follow; the next scheduled attempt is the retry.

Re-running is safe: a window already claimed from this machine is skipped, and
the server dedupes anyway. A duplicate POST is answered, never double-paid.

## Scheduling (the point of the feature)

The reward is time-boxed, so a scheduled trigger is the primary path — but the
schedule lives **outside the plugin**. A timer wired into the provider would tie
the marketing activity to the provider's lifecycle, which is the exact coupling
this design avoids.

Do not hand-write the path: let the script print the line for your OS, with
node's and the script's absolute paths already resolved.

```bash
node <skill-dir>/scripts/qoder-claim.mjs --schedule
```

On **Linux/macOS** it prints a `crontab` line — paste it into `crontab -e`:

```cron
5 12 * * * "…/node" "…/qoder-claim.mjs" --all >> "$HOME/.qoder-claim.log" 2>&1
```

On **Windows** (where cron simply does not exist) it prints a PowerShell
`Register-ScheduledTask` block — paste it into Windows PowerShell:

```powershell
$a = New-ScheduledTaskAction -Execute "…\node.exe" -Argument '"…\qoder-claim.mjs" --all'
$t = New-ScheduledTaskTrigger -Daily -At 12:05
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName "Qoder Claim" -Action $a -Trigger $t -Settings $s
```

`--schedule` only prints; it never installs anything or touches the network, so
review the line before arming it. Remove the job later with `crontab -e` or
`Unregister-ScheduledTask -TaskName "Qoder Claim" -Confirm:$false`.

Two notes:

- `12:05` is a habit, not a contract — the server owns the real window. The
  off-the-hour minute just keeps many installs from hitting the endpoint at the
  same second. Change it freely.
- `--StartWhenAvailable` (Windows) is the analogue of catching up: a machine
  asleep at noon still runs when it wakes, and a window already claimed is
  skipped, so a double fire costs nothing.

## What can go wrong, and what happens

The activity is expected to change or vanish. Each failure mode is already
handled and tells you in plain text:

| Situation                                   | Behaviour                                                       |
| ------------------------------------------- | --------------------------------------------------------------- |
| Endpoint removed (HTTP 404/410)             | 6 h cooldown; after 3 such runs, the report suggests disabling  |
| Campaign hidden (200, nothing on offer)     | Reported as `nothing on offer`, **no cooldown** — so a re-open  |
|                                             | is caught on the next run rather than suppressed                |
| Service hiccup (5xx / conflict)             | 45 min cooldown, retried on the next scheduled run              |
| Not eligible / blocked / revoked            | One line, exit 0 — a normal marketing answer, not a failure     |
| Credential dead                             | Exit 1, and the message points at `qoder-quota` for the fix     |

### Killing it

One switch removes the tools **and** the skill; nothing else in the plugin is
touched:

```bash
export OPENCODE_QODER_CLAIM=off     # or 0 / false / none
```

Because the skill lives in its own `skills-campaign/` folder rather than
`skills/`, deleting that directory is a second, physical way to withdraw it —
the permanent skills stay untouched either way.

## Do not

- **Do not hardcode "12:00".** The window is in the response (`startAt` /
  `endAt`); a timezone guess will claim against a closed window.
- **Do not execute the campaign's `placements[].commands[].js`.** qodercli runs
  server-delivered JavaScript for this command. This implementation only reads
  the campaign metadata and POSTs the documented claim route — running remote JS
  from a marketing payload is not something a provider plugin should do.
- **Do not "fix" a `nothing on offer` by retrying in a loop.** Visibility
  changes server-side within minutes (observed); the next scheduled run is the
  retry.
