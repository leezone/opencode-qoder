// Degenerate-output loop detection for streamed model responses.
//
// Low-tier models occasionally fall into a repetition loop: the same sentence,
// line, or code block re-emitted verbatim until the output budget drains.
// Upstream signals nothing while it happens (no finish_reason, no error
// envelope), so the only place to catch it is the delta flow itself.
//
// Detection: keep a rolling window of the emitted characters and test whether
// its tail has gone periodic -- the window ends with the same block repeated
// over and over. The prefix function (KMP failure) of the REVERSED window
// yields, for every suffix length m of the window, the smallest period
// m - pi(m-1); a suffix that is periodic with a small period and enough
// repeats at the very end is the loop signature. Reversing matters: a loop
// that starts mid-window (the window's left edge cuts into older, non-loop
// text) is a PREFIX of the reversal, so one prefix-function pass finds it
// without rescanning offsets.
//
// False-positive guardrails:
//   - the repeated block must contain >= 2 distinct characters, so decorative
//     runs ("----", "====", "……") never trip it
//   - short periods need many repeats (a 1-2 char period needs 100), so
//     laughter ("hahaha") and letter stutter survive
//   - the whole periodic span must reach MIN_SPAN before anything can trip
//
// Tool-call arguments are deliberately never fed through a guard: a truncated
// tool call (broken JSON handed to opencode) is worse than an expensive one.
// Text and reasoning deltas only.
//
// QODER_REPETITION_GUARD=0|off|false disables the guard for the process.

import { readEnv } from "./env.js";

// Rolling window size. Must hold the largest detectable span
// (MAX_PERIOD * 3 = 768) plus room for the non-periodic lead-in.
const WINDOW = 1536;

// Longest repeated block still considered a loop.
const MAX_PERIOD = 256;

// No suffix shorter than this can trip the guard (characters).
const MIN_SPAN = 192;

// Repeats a period must accumulate before it counts as a loop, tightening as
// the period shrinks. The resulting spans run from 192 chars (short periods)
// up to 768 chars (long ones).
function minRepeats(period: number): number {
  if (period <= 2) return 100;
  if (period <= 8) return 24;
  if (period <= 16) return 12;
  if (period <= 32) return 8;
  if (period <= 64) return 6;
  if (period <= 128) return 4;
  return 3;
}

// Appended as a fresh text block when a loop is cut, so the user -- and the
// model, reading the history next turn -- can see why the answer ended early.
export const REPETITION_MARKER = "\n\n[检测到重复循环输出，已截断]";

export function repetitionGuardEnabled(): boolean {
  const value = readEnv("QODER_REPETITION_GUARD").toLowerCase();
  return value !== "0" && value !== "off" && value !== "false";
}

// Reused across feeds: detect() is synchronous and never interleaves with
// another guard's detect(), so one module-level scratch buffer serves all.
const failure = new Int32Array(WINDOW);

export class RepetitionGuard {
  private tail = "";
  private fed = 0;
  private looped = false;

  feed(delta: string): void {
    if (this.looped || !delta) return;
    this.fed += delta.length;
    this.tail =
      this.tail.length + delta.length > WINDOW
        ? (this.tail + delta).slice(-WINDOW)
        : this.tail + delta;
    if (this.detect()) this.looped = true;
  }

  get tripped(): boolean {
    return this.looped;
  }

  get charsSeen(): number {
    return this.fed;
  }

  private detect(): boolean {
    const tail = this.tail;
    const n = tail.length;
    if (n < MIN_SPAN) return false;
    // Prefix function of the reversed window, read backwards without building
    // the reversed string: rev(i) === tail.charCodeAt(n - 1 - i).
    const pi = failure;
    pi[0] = 0;
    for (let i = 1; i < n; i++) {
      let j = pi[i - 1];
      const c = tail.charCodeAt(n - 1 - i);
      while (j > 0 && c !== tail.charCodeAt(n - 1 - j)) j = pi[j - 1];
      if (c === tail.charCodeAt(n - 1 - j)) j++;
      pi[i] = j;
    }
    for (let m = n; m >= MIN_SPAN; m--) {
      const period = m - pi[m - 1];
      if (period > MAX_PERIOD) continue;
      if (m < period * minRepeats(period)) continue;
      // The repeated block must not be a decorative single-character run.
      const first = tail.charCodeAt(n - period);
      let varied = false;
      for (let i = n - period + 1; i < n; i++) {
        if (tail.charCodeAt(i) !== first) {
          varied = true;
          break;
        }
      }
      if (varied) return true;
    }
    return false;
  }
}
