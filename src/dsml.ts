// Native tool-call markup repair, ported from the reference gateway's
// internal/upstream/dsml.go (same port opencode-workbuddy-connect ships).
//
// Qoder's DeepSeek-family backends have a NATIVE tool-call syntax: marker text
// separated by two full-width vertical bars (U+FF5C), not OpenAI JSON
// tool_calls. The upstream only parses that markup into structured tool_calls
// when the request declared `tools`. When a request carries no tools -- in
// opencode that is the title/compaction/plan agents, constantly -- the model
// may still want to call one, and the markup lands in `content` as plain
// text. Downstream nothing understands it, so the turn ends with the markup
// written into history and no tool ever ran.
//
// This is the last line of defense: recognize the markup in the outbound
// response and restore standard tool-call parts.
//
// Two judgment levels, because "which tools did the client declare" is not
// reliable on the wire:
//   strict (allowlist non-empty): every invoke's tool name must be in the list.
//   weak (allowlist empty): block must close perfectly, carry no prose, and
//     each tool name must look like an identifier -- placeholders like
//     <tool_name> or NAME that models write when DISCUSSING the syntax fail
//     the shape check.
// Hard preconditions for either level (any miss -> bytes pass through
// verbatim; this layer never swallows a byte):
//   - the block is fully closed and contains nothing but invoke/parameter tags
//     and whitespace;
//   - the turn produced no structured tool_calls of its own (never override a
//     real call);
//   - (non-stream only, enforced upstream of this module) finish is a normal
//     stop, not a max_tokens truncation.

export interface MarkupCall {
  name: string;
  /** JSON object text. */
  arguments: string;
}

const PIPE = "｜｜"; // two U+FF5C full-width vertical bars
const OPEN = `<${PIPE}DSML${PIPE} calls>`;
const CLOSE = `</${PIPE}DSML${PIPE} calls>`;
const INVOKE_CLOSE = `</${PIPE}DSML${PIPE} invoke>`;
const PARAM_CLOSE = `</${PIPE}DSML${PIPE} parameter>`;
const TAG_PREFIX = `<${PIPE}DSML${PIPE}`;

const INVOKE_RE = new RegExp(`${escapeRe(TAG_PREFIX)}\\s+invoke\\s+name="([^"]*)"\\s*>`, "u");
const PARAM_RE = new RegExp(
  `${escapeRe(TAG_PREFIX)}\\s+parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`,
  "u",
);
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/u;

/** A block still unclosed after this much accumulation is prose, not markup. */
const MAX_BLOCK_CHARS = 256 * 1024;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export class MarkupRepair {
  private hold = "";
  private inside = false;
  private seenCount = 0;
  private rejectedCount = 0;
  private convertedCount = 0;
  private allowed: Set<string>;
  private allowUnknown: boolean;

  constructor(allowed: ReadonlySet<string>, allowUnknown: boolean) {
    this.allowed = new Set(allowed);
    this.allowUnknown = allowUnknown;
  }

  get enabled(): boolean {
    return this.allowed.size > 0 || this.allowUnknown;
  }

  get seen(): number {
    return this.seenCount;
  }

  get rejected(): number {
    return this.rejectedCount;
  }

  get converted(): number {
    return this.convertedCount;
  }

  /**
   * Consumes one content delta; returns the text to emit verbatim and the
   * calls restored from any closed blocks. Invariant: the concatenation of all
   * inputs equals the concatenation of all returned text + flush() + the raw
   * markup of successfully converted blocks -- nothing else is dropped.
   */
  feed(text: string): { text: string; calls: MarkupCall[] } {
    if (!this.enabled) return { text, calls: [] };
    let s = this.hold + text;
    this.hold = "";
    let out = "";
    const calls: MarkupCall[] = [];
    for (;;) {
      if (!this.inside) {
        const start = startCandidate(s);
        if (start < 0) {
          out += s;
          break;
        }
        const rest = s.slice(start);
        if (rest.length < OPEN.length) {
          // The opener straddles a delta boundary: hold until the next piece.
          out += s.slice(0, start);
          this.hold = rest;
          break;
        }
        out += s.slice(0, start);
        s = s.slice(start + OPEN.length);
        this.inside = true;
        continue;
      }
      const end = s.indexOf(CLOSE);
      if (end < 0) {
        if (s.length > MAX_BLOCK_CHARS) {
          // Oversized and still open: prose that happens to contain the opener.
          out += OPEN + s;
          this.inside = false;
          break;
        }
        this.hold = s;
        break;
      }
      const inner = s.slice(0, end);
      s = s.slice(end + CLOSE.length);
      this.inside = false;
      this.seenCount += 1;
      const parsed = parseBlock(inner, this.allowed);
      if (parsed) {
        calls.push(...parsed);
        this.convertedCount += parsed.length;
        continue;
      }
      // Not a pure call block (prose inside / bad name / malformed params):
      // emit the original bytes, never swallow them.
      this.rejectedCount += 1;
      out += OPEN + inner + CLOSE;
    }
    return { text: out, calls };
  }

  /** At end of stream: hand back the still-undecided tail verbatim. */
  flush(): string {
    if (!this.enabled) return "";
    let out = this.hold;
    if (this.inside) out = OPEN + this.hold;
    this.hold = "";
    this.inside = false;
    return out;
  }

  /** Stops repairing permanently (structured tool_calls showed up) and
   * returns whatever was held so it can be emitted verbatim. */
  retire(): string {
    const tail = this.flush();
    this.allowed.clear();
    this.allowUnknown = false;
    return tail;
  }
}

/** The earliest index that starts either a complete OPEN or a prefix of it
 * (the opener may straddle a delta boundary). */
function startCandidate(s: string): number {
  for (let i = s.indexOf("<"); i >= 0; i = s.indexOf("<", i + 1)) {
    const rest = s.slice(i);
    if (rest.length >= OPEN.length) {
      if (rest.startsWith(OPEN)) return i;
      continue;
    }
    if (OPEN.startsWith(rest)) return i;
  }
  return -1;
}

/** Parses the inside of a calls block. Success requires: nothing but invokes
 * and whitespace; every invoke closed; every parameter list well-formed; tool
 * names passing the strict/weak gate. */
function parseBlock(inner: string, allowed: ReadonlySet<string>): MarkupCall[] | undefined {
  const strict = allowed.size > 0;
  const out: MarkupCall[] = [];
  let pos = 0;
  for (;;) {
    const invoke = INVOKE_RE.exec(inner.slice(pos));
    if (!invoke) break;
    if (inner.slice(pos, pos + invoke.index).trim() !== "") return undefined; // prose before an invoke
    const name = invoke[1];
    const bodyStart = pos + invoke.index + invoke[0].length;
    const bodyEnd = inner.indexOf(INVOKE_CLOSE, bodyStart);
    if (bodyEnd < 0) return undefined; // unclosed invoke
    const body = inner.slice(bodyStart, bodyEnd);
    pos = bodyEnd + INVOKE_CLOSE.length;
    const args = parseParams(body);
    if (args === undefined) return undefined;
    if (strict) {
      if (!allowed.has(name)) return undefined; // not a declared tool -> pass through
    } else if (!TOOL_NAME_RE.test(name)) {
      return undefined; // weak gate: not identifier-shaped -> pass through
    }
    out.push({ name, arguments: args });
  }
  if (out.length === 0) return undefined;
  if (inner.slice(pos).trim() !== "") return undefined; // prose after the last invoke
  return out;
}

/** Parses one invoke's parameter list into a JSON object text.
 * string="true" values stay literal strings (JSON-escaped on marshal); other
 * values parse as JSON first, degrading to the raw string -- a value is never
 * lost, at worst mistyped. Tools without parameters produce "{}". */
function parseParams(body: string): string | undefined {
  const args: Record<string, unknown> = {};
  let pos = 0;
  for (;;) {
    const param = PARAM_RE.exec(body.slice(pos));
    if (!param) break;
    if (body.slice(pos, pos + param.index).trim() !== "") return undefined;
    const name = param[1];
    const isString = param[2] === "true";
    const valueStart = pos + param.index + param[0].length;
    const valueEnd = body.indexOf(PARAM_CLOSE, valueStart);
    if (valueEnd < 0) return undefined;
    const raw = body.slice(valueStart, valueEnd);
    pos = valueEnd + PARAM_CLOSE.length;
    if (isString) {
      args[name] = raw;
      continue;
    }
    const trimmed = raw.trim();
    try {
      args[name] = JSON.parse(trimmed);
    } catch {
      args[name] = raw;
    }
  }
  if (body.slice(pos).trim() !== "") return undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/**
 * Tool-name allowlist from the outbound request body: both sources matter and
 * either can be missing -- the tools declared THIS request, plus every tool
 * name the client itself wrote into history (`messages[].tool_calls`), which
 * is naturally trustworthy. Empty set -> the weak gate applies.
 */
export function collectToolNames(body: { tools?: unknown; messages?: unknown }): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const record = tool as { name?: unknown; function?: { name?: unknown } } | null;
      if (!record) continue;
      const fnName = record.function?.name;
      if (typeof fnName === "string" && fnName !== "") names.add(fnName);
      else if (typeof record.name === "string" && record.name !== "") names.add(record.name);
    }
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const record = message as { tool_calls?: unknown } | null;
      if (!record || !Array.isArray(record.tool_calls)) continue;
      for (const call of record.tool_calls) {
        const name = (call as { function?: { name?: unknown } } | null)?.function?.name;
        if (typeof name === "string" && name !== "") names.add(name);
      }
    }
  }
  return names;
}
