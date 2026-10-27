// Scratchpad-markup repair for the *content* channel.
//
// Qoder's DeepSeek-family backends do not always deliver their thinking over
// `reasoning_content`. Observed on stored sessions (opencode part table,
// provider=qoder, model dmodel/dfmodel/qfmodel):
//
//   - the whole scratchpad arrives on `content`, prefixed by a pseudo-tag, and
//     `tokens.reasoning` is 0 for that turn -- upstream never classified it;
//   - the tag itself is mangled on the way through the gateway: a bare
//     "<thinking" with the ">" gone, an opener with no close tag at all
//     ("<reading>…", 27 stored turns), or a closing tag whose opener never
//     arrived ("</thinking>", the most common shape by far).
//
// Nothing downstream understands that markup, so it renders in the answer body
// verbatim. ThinkingTagParser can only cut a *matched pair* of one of its four
// known variants, which leaves three leftovers it cannot touch:
//
//   1. a stray close tag                     -> scrub (never meaningful in prose)
//   2. a bare opener ("<thinking" no ">")    -> scrub the fragment
//   3. an opener with no close tag           -> recoverable only by guessing;
//                                               see leadingScratchpadOpen()
//
// Both entry points leave inline code alone: an answer that *discusses* this
// markup writes it as `<thinking>` or "</thinking>", and deleting the thing
// under discussion would be worse than the leak.

import { readEnv } from "./env.js";

// Names treated as scratchpad delimiters.
//
// The first four are the variants ThinkingTagParser already reroutes, kept here
// so their leftovers are scrubbed by the same rules. `reading` and `knowledge`
// are the two names Qoder's DeepSeek models actually invented in stored
// sessions. Deliberately absent: `analysis`/`summary` (opencode's compaction
// prompt asks for them, so they are legitimate answer text) and bare HTML the
// model writes on purpose (`details`, `summary`, `contents`).
const SCRATCHPAD_NAMES = ["thinking", "think", "reasoning", "thought", "reading", "knowledge"];

const NAME_SET = new Set(SCRATCHPAD_NAMES);

// Longer than any real `<name attr="…">` shard; a "block" still open after
// this much text is prose that happens to contain the opener, so it is emitted
// verbatim rather than held forever.
const MAX_SHARD_CHARS = 512;

// A tag name continues over [a-z0-9_] only. Uppercase is deliberately NOT part
// of a name: the leak this file repairs looks like "<thinkingThere IS a dist.",
// where the name ends and the scratchpad starts at the capital -- and every
// scratchpad name is lowercase, so no real marker is lost.
function isNameContinuation(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9_]/u.test(ch);
}

// Close tags get the stricter boundary: "</thinkingX" is someone else's word,
// not this marker.
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/u.test(ch);
}

/**
 * QODER_SCRATCHPAD_GUESS=0|off|false disables the leading-opener guess.
 *
 * On by default: the alternative is showing a whole scratchpad as the answer,
 * and the failure it guards against (an answer appended after an unclosed
 * opener) hides one paragraph, not the turn's tool call.
 */
export function scratchpadGuessEnabled(): boolean {
  const value = readEnv("QODER_SCRATCHPAD_GUESS").toLowerCase();
  return value !== "0" && value !== "off" && value !== "false";
}

/** Greedy match of a scratchpad name at `start`.
 *
 * "partial" means the buffer ended inside the name -- more input may still turn
 * it into a marker, so the caller must hold these bytes rather than emit them.
 */
function matchName(
  text: string,
  start: number,
): { end: number; name: string } | "partial" | undefined {
  let i = start;
  while (i < text.length && isNameContinuation(text[i])) i++;
  if (i === text.length) {
    const name = text.slice(start).toLowerCase();
    return SCRATCHPAD_NAMES.some((candidate) => candidate.startsWith(name)) ? "partial" : undefined;
  }
  if (i === start) return undefined;
  const name = text.slice(start, i).toLowerCase();
  return NAME_SET.has(name) ? { end: i, name } : undefined;
}

/** One marker fragment at the very start of `text`.
 *
 * Returns the length to drop, or "partial" when the buffer ends too early to
 * decide, or undefined when the bytes are not a fragment at all.
 */
function matchFragment(text: string): { drop: number } | "partial" | undefined {
  if (text.length < 2) return "partial"; // "<" alone starts everything below
  const closes = text[1] === "/";
  const matched = matchName(text, closes ? 2 : 1);
  if (matched === "partial") return "partial";
  if (matched === undefined) {
    // `<parameter name="…">` / `<invoke name="…">`: the argument shards of a
    // tool call whose `｜｜DSML｜｜` wrapper the gateway already ate. Keep the
    // value, drop the shard.
    return matchArgumentShard(text, closes);
  }
  const next = text[matched.end];
  if (closes) {
    if (next === ">") return { drop: matched.end + 1 };
    if (next === undefined) return "partial";
    return isWordChar(next) ? undefined : { drop: matched.end };
  }
  if (next === ">") return { drop: matched.end + 1 };
  if (next === undefined) return "partial";
  // "<thinkingThere IS …" -- the gateway swallowed the ">". Drop only the
  // fragment itself and let the prose through.
  return isNameContinuation(next) ? undefined : { drop: matched.end };
}

const SHARD_KEYWORDS = ["parameter", "invoke"];

function matchArgumentShard(
  text: string,
  closes: boolean,
): { drop: number } | "partial" | undefined {
  const prefixLength = closes ? 2 : 1;
  const body = text.slice(prefixLength).toLowerCase();
  const keyword = SHARD_KEYWORDS.find(
    (candidate) => body.startsWith(candidate) || candidate.startsWith(body),
  );
  if (keyword === undefined) return undefined;
  // Buffer ended inside the keyword: "<param" may still become "<parameter".
  if (!body.startsWith(keyword)) return "partial";
  const rest = body.slice(keyword.length);
  if (rest === "") return "partial";
  if (closes) {
    if (!rest.startsWith(">")) return undefined; // "</parameterX"
    return { drop: prefixLength + keyword.length + 1 };
  }
  if (!/^\s/u.test(rest)) return undefined;
  const end = text.indexOf(">");
  if (end !== -1) return { drop: end + 1 };
  return text.length < MAX_SHARD_CHARS ? "partial" : undefined;
}

/**
 * Drops stray scratchpad marker fragments from a streamed text channel, holding
 * a trailing partial marker across delta boundaries so a fragment split in two
 * is still recognised. Never swallows a byte it does not positively identify.
 */
export class MarkerScrubber {
  private hold = "";
  private droppedFragments = 0;
  // Inside `…` or a ``` fence: model-authored prose about the markup stays
  // byte-identical. Tracked separately so a lone backtick inside a fence does
  // not toggle anything.
  private fence = false;
  private inlineCode = false;

  private get inCode(): boolean {
    return this.fence || this.inlineCode;
  }

  feed(delta: string): string {
    const text = this.hold + delta;
    this.hold = "";
    let out = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "`") {
        let run = i;
        while (run < text.length && text[run] === "`") run++;
        if (run === text.length) {
          this.hold = text.slice(i); // the run may continue in the next delta
          break;
        }
        // NOTE: run is an end index; the run length is run - i. Comparing the
        // index instead of the length turned every single backtick into a fence.
        if (run - i >= 3) {
          this.fence = !this.fence;
          this.inlineCode = false;
        } else if (!this.fence) {
          this.inlineCode = !this.inlineCode;
        }
        out += text.slice(i, run);
        i = run;
        continue;
      }
      if (ch !== "<" || this.inCode) {
        out += ch;
        i++;
        continue;
      }
      const fragment = matchFragment(text.slice(i));
      if (fragment === "partial") {
        this.hold = text.slice(i);
        break;
      }
      if (fragment === undefined) {
        out += ch;
        i++;
        continue;
      }
      this.droppedFragments += 1; // a marker fragment: dropped, not emitted
      i += fragment.drop;
    }
    return out;
  }

  /** End of a text block: undecided bytes belong to the answer after all. */
  flush(): string {
    const tail = this.hold;
    this.hold = "";
    return tail;
  }

  /** Fragments dropped so far; logged once per response when non-zero. */
  get dropped(): number {
    return this.droppedFragments;
  }

  /** Test/debug surface: is a fragment still undecided? */
  get pending(): string {
    return this.hold;
  }
}

/**
 * A scratchpad opener at the very start of the content stream.
 *
 * Used by ThinkingTagParser to reroute the follow-on prose to a reasoning block.
 * Returns "partial" when the buffer ends too early to decide; the caller holds
 * those bytes instead of emitting them.
 *
 * The open tag's ">" may be missing (`<thinkingThere IS …`), which is why the
 * bare form matches too. An opener that never closes leaves the caller in
 * thinking mode until finalize(), which files the whole buffer as reasoning:
 * the observed unclosed turns are pure scratchpad followed by a tool call, so
 * nothing user-visible is lost.
 */
export function leadingScratchpadOpen(
  text: string,
): { length: number; close: string; name: string; bare: boolean } | "partial" | undefined {
  if (!text.startsWith("<")) return text === "" ? "partial" : undefined;
  const matched = matchName(text, 1);
  if (matched === "partial") return "partial";
  if (matched === undefined) return undefined;
  const next = text[matched.end];
  const close = `</${matched.name}>`;
  if (next === ">") return { length: matched.end + 1, close, name: matched.name, bare: false };
  if (next === undefined) return "partial";
  // "<thinkingThere" -- bare opener, the gateway ate the ">".
  return isNameContinuation(next)
    ? undefined
    : { length: matched.end, close, name: matched.name, bare: true };
}
