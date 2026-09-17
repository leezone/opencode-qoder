#!/usr/bin/env node
// Qoder account + credit quota reader, and the out-of-band PAT-store recovery
// hatch (see --pats / --use-pat under Usage). It is a thin CLI over the
// plugin's own quota-CLI module rather than a second implementation, so the
// credential layers, the PAT store and the quota buckets cannot drift from
// what qoder_quota() and friends do inside a chat -- the pattern the claim
// skill set with dist/claim.js. The copy that lived here used to re-implement
// the whole chain, and it had already drifted (a merged "shared" bucket vs a
// separate one; the env var ranked first here and last in auth.ts).
//
// The module it loads touches the network with a plain Bearer token and needs
// no opencode runtime, which is what makes a standalone run possible: a cron
// line, a bare shell, or a session on another provider while a dead Qoder
// credential puts every in-chat Qoder tool out of reach.
//
//   node qoder-quota.mjs            human summary
//   node qoder-quota.mjs --json     machine-readable
//   node qoder-quota.mjs --pats     probe every PAT in the plugin's store
//   node qoder-quota.mjs --use-pat=<id>   validate it, then select + activate it
//   node qoder-quota.mjs --resolve  which credential layer answers (offline)
//
// Add --region=cn to read the China deployment's store and endpoints instead of
// the international ones; the region is part of the credential chain, so
// --resolve --region=cn and the default can legitimately disagree.
//
// Exit codes: 0 = data fetched (credits may still be spent) / a switch landed;
// 1 = nothing usable came back, with the reason on stderr.

import fs from "node:fs";
import path from "path";
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
      "Usage: node qoder-quota.mjs [--json] [--pat=<pt-...>] [--token=<jt-...>] [--region=global|cn]",
      "       node qoder-quota.mjs --pats",
      "       node qoder-quota.mjs --use-pat=<id|label> [--force]",
      "       node qoder-quota.mjs --resolve",
      "",
      "Reads Qoder credit quota + account info through the plugin's own modules",
      "(dist/quota-cli.js): one credential chain, one bucket table, in this shell",
      "and in a chat alike. Exit 0 = data fetched (even if credits are spent),",
      "1 = nothing usable came back.",
      "",
      "--resolve prints which credential layer answers, with no network call and",
      "no token bytes -- the offline answer to 'I switched accounts, why is this",
      "still the old one'. It walks exactly the auth.ts precedence: the store's",
      "selected entry above the connection record, the configured apiKey, the key",
      "file, the store's active entry, the environment. --pat / --token sit above",
      "the whole table on purpose (an explicit CLI act).",
      "",
      "--pats and --use-pat are the shell-side recovery hatch for a dead ACTIVE",
      "PAT: with no credential no chat can run (not even the free lite model --",
      "zero credits is still signed auth), which also puts the in-conversation",
      "switch tool out of reach. These modes need no chat: they probe every PAT",
      "in the plugin's store with a live exchange + quota read (both unmetered",
      "identity endpoints) and can rewrite which entry is active AND selected. The",
      "plugin re-reads the store by mtime, so a switch applies to a running",
      "opencode without a restart.",
    ].join("\n"),
  );
  process.exit(0);
}

// Resolve dist/quota-cli.js from this file's own location so the script follows
// the plugin it shipped with: a repo checkout, an npm cache install, or a
// global node_modules tree all land on the right package. fileURLToPath, not
// URL.pathname: the latter returns "/C:/..." on Windows and every fs probe
// below then misses.
function cliModuleUrl() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // <pkg>/skills/qoder-quota/scripts -> <pkg>/dist/quota-cli.js
    path.resolve(here, "../../../dist/quota-cli.js"),
    // a copied-out skill pointing at a built checkout
    process.env.QODER_PLUGIN_DIST ? path.join(process.env.QODER_PLUGIN_DIST, "quota-cli.js") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  console.error(
    [
      "Cannot find the plugin's build output (dist/quota-cli.js).",
      `Looked in: ${candidates.join(", ")}`,
      "In a source checkout, build first:  npm run build",
      "An installed plugin already has it; a stale path means the skill was copied",
      "out of the package, where it can no longer see the module. Use the plugin.",
    ].join("\n"),
  );
  process.exit(1);
}

const { runQuotaCli, runPatsCli, runUsePatCli, runResolveCli } = await import(cliModuleUrl());

// The module never throws; it reports. The wrapper owns only argv and exit.
function finish(report) {
  if (report.output) console.log(report.output);
  if (report.stderr) console.error(report.stderr);
  process.exit(report.exitCode);
}

const region = option("region") === "cn" ? "cn" : "global";
const cli = { pat: option("pat"), token: option("token"), json: flag("json"), region };

if (flag("resolve")) finish(runResolveCli(cli));
if (flag("pats")) finish(await runPatsCli(cli));
const target = option("use-pat");
if (target)
  finish(await runUsePatCli(target, { force: flag("force"), json: cli.json, region }));
finish(await runQuotaCli(cli));
