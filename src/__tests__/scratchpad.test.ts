import { afterEach, describe, expect, it } from "vitest";
import { leadingScratchpadOpen, MarkerScrubber, scratchpadGuessEnabled } from "../scratchpad.js";

// These fragments are the leftovers Qoder's gateway puts on the content channel:
// it eats part of its own thinking marker while switching channels, so what
// arrives here is either a bare opener ("<thinking" with no ">"), an opener with
// no close tag at all, or an orphan close tag. Every case below is a shape
// observed in a stored opencode session.

describe("MarkerScrubber", () => {
  it("drops an orphan closing tag", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("路径又猜错了。查真实搜索路由：</thinking>\n")).toBe(
      "路径又猜错了。查真实搜索路由：\n",
    );
    expect(scrubber.pending).toBe("");
  });

  it("drops the <think> spelling too", () => {
    expect(new MarkerScrubber().feed("answer</think>")).toBe("answer");
  });

  it("drops a bare opener and keeps the prose", () => {
    // The observed shape: "<thinking" immediately followed by the scratchpad.
    expect(new MarkerScrubber().feed("<thinkingThere IS a web dist.")).toBe("There IS a web dist.");
  });

  it("recognises a marker split across deltas", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("答：</think")).toBe("答：");
    expect(scrubber.pending).toBe("</think");
    expect(scrubber.feed("ing>\n")).toBe("\n");
  });

  it("drops a tool-call argument shard but keeps its value", () => {
    // "<parameter name="…">" reaches us with the ｜｜DSML｜｜ wrapper already gone.
    expect(new MarkerScrubber().feed('<parameter name="confirmed"> Key findings: x')).toBe(
      " Key findings: x",
    );
    expect(new MarkerScrubber().feed("</parameter>")).toBe("");
  });

  it("holds a shard whose attributes are still streaming", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed('<parameter name="con')).toBe("");
    expect(scrubber.feed('firmed">value')).toBe("value");
  });

  it("leaves markup the model is discussing alone", () => {
    // Backticks: a user-facing answer that names the tag must keep it.
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("it emits `</thinking>` inline")).toBe("it emits `</thinking>` inline");
    const fenced = new MarkerScrubber();
    expect(fenced.feed("```\n<thinking>x</thinking>\n```\n")).toBe(
      "```\n<thinking>x</thinking>\n```\n",
    );
  });

  it("keeps a lone backtick inside a fence from ending the fence", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("```\nfoo ` bar </thinking>\n```\nplain</thinking>")).toBe(
      "```\nfoo ` bar </thinking>\n```\nplain",
    );
  });

  it("does not touch unrelated markup", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("<div>hi</div> <thinkingx>")).toBe("<div>hi</div> <thinkingx>");
  });

  it("gives back an undecided tail on flush instead of swallowing it", () => {
    const scrubber = new MarkerScrubber();
    expect(scrubber.feed("tail <thin")).toBe("tail ");
    expect(scrubber.flush()).toBe("<thin");
    expect(scrubber.flush()).toBe("");
  });
});

describe("leadingScratchpadOpen", () => {
  afterEach(() => {
    delete process.env.QODER_SCRATCHPAD_GUESS;
  });

  it("matches a complete opener of a name the tag parser does not know", () => {
    expect(leadingScratchpadOpen("<reading>Confirmed: x")).toEqual({
      length: 9,
      close: "</reading>",
      name: "reading",
      bare: false,
    });
  });

  it("matches a bare opener whose '>' the gateway ate", () => {
    expect(leadingScratchpadOpen("<thinkingThere IS a web dist.")).toEqual({
      length: 9,
      close: "</thinking>",
      name: "thinking",
      bare: true,
    });
  });

  it("reports a marker still streaming in as partial", () => {
    expect(leadingScratchpadOpen("<read")).toBe("partial");
    expect(leadingScratchpadOpen("<")).toBe("partial");
  });

  it("ignores anything that is not a scratchpad marker", () => {
    expect(leadingScratchpadOpen("<div>hi")).toBeUndefined();
    expect(leadingScratchpadOpen("</thinking>")).toBeUndefined();
    expect(leadingScratchpadOpen("plain answer")).toBeUndefined();
  });

  it("is on by default and off via QODER_SCRATCHPAD_GUESS", () => {
    expect(scratchpadGuessEnabled()).toBe(true);
    for (const off of ["0", "off", "false", "OFF"]) {
      process.env.QODER_SCRATCHPAD_GUESS = off;
      expect(scratchpadGuessEnabled()).toBe(false);
    }
    process.env.QODER_SCRATCHPAD_GUESS = "1";
    expect(scratchpadGuessEnabled()).toBe(true);
  });
});
