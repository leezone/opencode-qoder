#!/usr/bin/env node
// Daily campaign claim, for the places no opencode conversation runs: a cron
// line (Linux/macOS), a Task Scheduler job (Windows), or a bare shell. It is a
// thin CLI over the plugin's own claim module rather than a second
// implementation, so the endpoints, the status vocabulary and the local
// "already claimed" markers cannot drift from what qoder_claim() does inside a
// chat.
//
// The module it loads touches the network with a plain Bearer token and needs no
// opencode runtime, which is what makes a standalone scheduled run possible.
//
//   node qoder-claim.mjs              claim for the active account
//   node qoder-claim.mjs --status     read-only report, never a claim
//   node qoder-claim.mjs --all        every stored PAT
//   node qoder-claim.mjs --json       machine-readable verdicts
//   node qoder-claim.mjs --reset      clear local cooldown markers
//   node qoder-claim.mjs --pat=pt-…   pin one account for this run
//   node qoder-claim.mjs --schedule   print the cron/schtasks line for THIS install
//
// Exit codes, chosen so the scheduled job needs no wrapper to be useful:
//   0  did its job -- including "nothing to claim today", "already claimed" and
//      "cooling down". A closed window is not an operational failure, and a red
//      run every morning teaches you to ignore the job.
//   1  nothing usable came back: no credential, or a verdict that needs a human
//      (an unknown answer from the claim route, or the service rejecting us).
//   2  the feature is switched off by env while the job still fired -- the
//      activity was withdrawn, so take the job down.
// A cooldown reports 0 and sends no request; the run that CAUSED it reports 1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

if (flag("help")) {
  console.log(
    [
      "Usage: node qoder-claim.mjs [--status] [--all] [--json] [--reset] [--pat=pt-...]",
      "       node qoder-claim.mjs --schedule",
      "",
      "Claims Qoder's daily campaign reward (the check-in behind qodercli's /claim).",
      "A marketing surface: it can be withdrawn at any time, and every failure mode",
      "answers in plain text instead of throwing.",
      "",
      "--schedule prints the recurring-job line for THIS machine -- a crontab line on",
      "Linux/macOS, a PowerShell Register-ScheduledTask on Windows -- with node's and",
      "this script's absolute paths already filled in. It prints only; you arm it.",
      "",
      "Exit 0 = job done (nothing to claim today / already claimed / cooling down).",
      "     1 = no credential, or a verdict needing a human.",
      "     2 = switched off by OPENCODE_QODER_CLAIM while the job still fired:",
      "         the activity is withdrawn -- take the job down.",
      "",
      "The window and eligibility come from the server. Nothing here assumes 12:00,",
      "and a window claimed from this machine before is skipped, so re-running is safe.",
    ].join("\n"),
  );
  process.exit(0);
}

// --schedule: hand the user the exact line that arms the recurring job, with
// the absolute node/script paths resolved -- the thing that makes "just use
// cron" copy-pasteable and, on Windows, where cron does not exist, the reason a
// hand-written doc line silently fails there. Platform is decided at print time,
// so a line generated on one OS is not pasted onto another. It prints and
// exits WITHOUT loading the claim module or touching the network: generating a
// suggestion must not need a build or a credential. The runnable line goes to
// stdout (pipeable); the "how to arm it" hint to stderr, so stdout stays clean.
if (flag("schedule")) {
  const script = fileURLToPath(import.meta.url);
  const node = process.execPath;
  const home = os.homedir();
  // "12:05" is a habit, not a contract: the server owns the window. The 05
  // minute keeps a fleet off the exact top of the hour.
  if (process.platform === "win32") {
    // Task Scheduler via PowerShell, not `schtasks /TR`: the /TR value is one
    // quoted string that must itself carry escaped quotes and a redirect, and
    // getting that right by eye across cmd/PowerShell quoting is a trap.
    // -Argument is simpler to reason about: the value is stored verbatim and
    // the task engine (not PowerShell) parses it when the task runs, so a
    // script path with spaces must arrive already quoted. The emitted line
    // single-quotes the whole value -- inside a PowerShell '...' literal the
    // double quotes are literal characters -- so `"C:\...\qoder-claim.mjs"
    // --all` reaches the task intact. -StartWhenAvailable is the Windows
    // analogue of "run it when I wake up": a laptop asleep at noon still
    // claims once the lid opens, instead of losing the day.
    const argument = `"${script}" --all`;
    console.log(
      [
        `$a = New-ScheduledTaskAction -Execute "${node}" -Argument '${argument}'`,
        `$t = New-ScheduledTaskTrigger -Daily -At 12:05`,
        `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable`,
        `Register-ScheduledTask -TaskName "Qoder Claim" -Action $a -Trigger $t -Settings $s`,
      ].join("\n"),
    );
    console.error(
      [
        "",
        "Paste those four lines into Windows PowerShell to arm the daily job.",
        `Remove it:  Unregister-ScheduledTask -TaskName "Qoder Claim" -Confirm:$false`,
        "Run it once now to test:  Start-ScheduledTask -TaskName \"Qoder Claim\"",
      ].join("\n"),
    );
  } else {
    // cron: the absolute home path, not $HOME -- cron runs the line with its own
    // minimal environment and does not expand $HOME the way an interactive shell
    // does, so a literal ~ or $HOME would redirect into a lost file.
    console.log(
      `5 12 * * * "${node}" "${script}" --all >> "${path.join(home, ".qoder-claim.log")}" 2>&1`,
    );
    console.error(
      [
        "",
        "Add that line with `crontab -e`. The log path is absolute because cron",
        "runs with a minimal environment and will not expand $HOME for you.",
        "Remove it by editing `crontab -e` again; test it with the command above run",
        "straight from a shell.",
      ].join("\n"),
    );
  }
  process.exit(0);
}

// Resolve dist/claim.js from this file's own location so the script follows the
// plugin it shipped with: a repo checkout (src/../dist), an npm cache install,
// or a global node_modules tree all land on the right package. fileURLToPath,
// not URL.pathname: the latter returns "/C:/..." on Windows and every fs probe
// below then misses -- the one place a Windows path is made absolute here.
function claimModuleUrl() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // <pkg>/skills-campaign/qoder-claim/scripts -> <pkg>/dist/claim.js
    path.resolve(here, "../../../dist/claim.js"),
    // a copied-out skill with a QODER_QODER_DIST override, for a checkout that
    // has not been built where the skill was pointed at
    process.env.QODER_PLUGIN_DIST ? path.join(process.env.QODER_PLUGIN_DIST, "claim.js") : "",
    // dev tree: src is TypeScript, so only the build output is usable
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  console.error(
    [
      "Cannot find the plugin's build output (dist/claim.js).",
      `Looked in: ${candidates.join(", ")}`,
      "In a source checkout, build first:  npm run build",
      "An installed plugin already has it; a stale path means the skill was copied",
      "out of the package, where it can no longer see the module. Use the plugin.",
    ].join("\n"),
  );
  process.exit(1);
}

const { claimDisabled, reportCampaigns, runClaim } = await import(claimModuleUrl());

const env = process.env.OPENCODE_QODER_CLAIM || "";
const disabled = claimDisabled();
const wantsJson = flag("json");

function finish(report, { offExitCode }) {
  if (wantsJson) {
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          disabled,
          disabledVia: disabled ? `OPENCODE_QODER_CLAIM=${env || "unset"}` : "",
          ...report.data,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(report.output);
  }
  if (disabled) process.exit(offExitCode);
  // The module never throws; it reports. A claim attempt is judged from the
  // per-account outcomes so a timer says nothing on a good run.
  const attempts = report.data.attempts ?? [];
  const hard = attempts.filter((a) => a.outcome === "ERROR" || a.outcome === "SERVICE_UNAVAILABLE");
  const landed = attempts.filter((a) => a.outcome === "CLAIMED");
  if (hard.length && !landed.length) process.exit(1);
  process.exit(0);
}

const options = option("pat") ? { personalAccessToken: option("pat") } : {};
const callOptions = { all: flag("all") };

if (flag("reset")) {
  finish(await runClaim(options, { ...callOptions, reset: true }), { offExitCode: 2 });
}

if (flag("status")) {
  finish(await reportCampaigns(options, callOptions), { offExitCode: 2 });
}

finish(await runClaim(options, callOptions), { offExitCode: 2 });
