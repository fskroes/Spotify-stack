import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_READ_MAX_CALLS, JUDGE_READ_TOOLS } from "@fleet/judge-read";
import { createJudgeClient, judge, judgeWithEvidence } from "../src/index.js";

/**
 * The SDK judge's tool loop (`docs/judge-cage-spec.md` §5.2, deciding ADR-0011).
 *
 * The CLI transport gets its loop for free — the `claude` subprocess runs one.
 * The SDK transport has to run its own, and these tests are what say it does:
 * a scripted Anthropic that hands back the turns the live probe recorded
 * (`artifacts/judge-probe/results-structured-output-with-tools.json`), and a
 * *real* rooted reader over a real temp workspace. Nothing about the read side
 * is faked, because the thing under test is that a read actually reaches it.
 */
let tmp: string;
let workspace: string;

const VERDICT = {
  verdict: "veto",
  violations: ["src/index.js: the re-export the task asked for is missing"],
  guidance: "Add the re-export.",
  rationale: "Read src/index.js; it exports only `alpha`.",
};

beforeEach(() => {
  // The workspace sits *inside* a temp root rather than being one, so a test
  // can put a file next to it that the judge must not be able to reach.
  tmp = mkdtempSync(path.join(os.tmpdir(), "sdk-judge-"));
  workspace = path.join(tmp, "ws");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "src", "index.js"), "export { alpha } from './alpha.js';\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * One turn as the API returns it — content blocks, no `parsed_output`. Parsing
 * is the SDK helper's doing, and the fake below does it the SDK's way rather
 * than by handing back a pre-parsed answer.
 */
type Turn = { stop_reason: string; content: unknown[]; model?: string; usage?: unknown };

const toolUseTurn = (id: string, name: string, input: Record<string, unknown>): Turn => ({
  stop_reason: "tool_use",
  // Thinking rides along with tool use on the real wire, and has to survive the
  // round trip — the API rejects a tool result whose assistant turn lost it.
  content: [
    { type: "thinking", thinking: "checking the source", signature: "sig" },
    { type: "tool_use", id, name, input },
  ],
  model: "claude-opus-4-8",
});

const verdictTurn = (verdict: unknown = VERDICT): Turn => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(verdict) }],
  model: "claude-opus-4-8",
});

/**
 * A scripted Anthropic that hands back queued turns and records what it was
 * sent — offering **both** entry points the SDK offers, because which one the
 * loop drives is load-bearing.
 *
 * `parse` here is not an imitation of the SDK's helper: it runs the *actual*
 * parse function the caller put on `output_config.format`, which is what
 * `zodOutputFormat` builds and what the SDK itself calls on every text block.
 * So it throws exactly where the real client throws — and a fake that returned
 * a pre-parsed verdict instead would be blind to the one failure that only
 * shows up in production.
 */
function scripted(turns: Turn[]): {
  messages: {
    create(params: Record<string, unknown>): Promise<Turn>;
    parse(params: Record<string, unknown>): Promise<Turn & { parsed_output: unknown }>;
  };
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const messages = {
    async create(params: Record<string, unknown>) {
      sent.push(params);
      const turn = turns.shift();
      if (!turn) throw new Error("the loop asked for more turns than the script has");
      return turn;
    },
    async parse(params: Record<string, unknown>) {
      const turn = await messages.create(params);
      const format = (params.output_config as { format?: { parse?(text: string): unknown } } | undefined)?.format;
      let parsed: unknown = null;
      for (const block of turn.content as { type: string; text?: string }[]) {
        if (block.type !== "text" || !format?.parse) continue;
        const output = format.parse(block.text ?? "");
        parsed ??= output;
      }
      return { ...turn, parsed_output: parsed };
    },
  };
  return { sent, messages };
}

describe("the SDK judge's tool loop", () => {
  it("returns a parsed verdict for a review that had to read the workspace", async () => {
    // The hazard this ticket exists to avoid: a tool-use turn carries
    // `parsed_output: null` (measured, #104), so bolting the read tool onto the
    // single-shot call turns every verdict that *used* the tool into a failed
    // run — the tool would look like it worked, and the runs that used it would
    // be the ones that died.
    const anthropic = scripted([
      toolUseTurn("tu_1", "read_file", { path: "src/index.js" }),
      verdictTurn(),
    ]);

    const verdict = await judge({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    expect(verdict.verdict).toBe("veto");
    expect(verdict.rationale).toContain("src/index.js");
  });

  it("survives a judge that says something out loud before it reads", async () => {
    // The same hazard as above, arriving by a second door — and this one the
    // #104 probe could not see, because the turn it recorded carried only
    // thinking and a tool call.
    //
    // The SDK's `parse` helper runs the verdict schema over *every* text block
    // it is handed and throws on one that is not a verdict. A model that
    // narrates before calling a tool ("let me check the index") produces
    // exactly that block, and driving the loop through `parse` would turn its
    // review into a failed run. The loop therefore drives `create` and reads
    // the verdict off the final turn itself.
    const anthropic = scripted([
      {
        ...toolUseTurn("tu_1", "read_file", { path: "src/index.js" }),
        content: [
          { type: "text", text: "Let me check what src/index.js actually exports." },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/index.js" } },
        ],
      },
      verdictTurn(),
    ]);

    const verdict = await judge({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    expect(verdict.verdict).toBe("veto");
  });

  it("hands the read tools' answer back in one user message, and carries the assistant turn with it", async () => {
    const anthropic = scripted([
      {
        ...toolUseTurn("tu_1", "read_file", { path: "src/index.js" }),
        content: [
          { type: "thinking", thinking: "checking the source", signature: "sig" },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/index.js" } },
          { type: "tool_use", id: "tu_2", name: "find", input: { glob: "src/*.js" } },
        ],
      },
      verdictTurn(),
    ]);

    await judge({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    const messages = anthropic.sent[1].messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The assistant turn goes back whole, thinking block included: the API
    // rejects a tool result whose assistant turn dropped it.
    expect((messages[1].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);

    const results = messages[2].content as Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2"]);
    // Served by the real reader against the real workspace: this is the file's
    // actual first line, and the find's actual match.
    expect(results[0].content).toContain("export { alpha }");
    expect(results[0].is_error).toBe(false);
    expect(results[1].content).toBe("src/index.js");
  });

  it("fails the run when the judge never stops reading, instead of answering without the reads", async () => {
    // Exhaustion is a failure, not a fallthrough. One more tool-free request
    // would produce a text-only verdict recorded under a name claiming reads —
    // the ADR-0011 condition, arrived at by exhaustion rather than by config.
    let sent = 0;
    const anthropic = {
      messages: {
        async create() {
          sent += 1;
          return toolUseTurn(`tu_${sent}`, "read_file", { path: "src/index.js" });
        },
      },
    };

    await expect(
      judge({
        taskMarkdown: "task",
        diff: "diff",
        verifySummary: "VERIFY PASSED",
        workspace,
        client: createJudgeClient({ workspace, ...anthropic }),
      }),
    ).rejects.toThrow(/did not reach a verdict/);

    // Bounded — and never below the reader's own call budget: a judge spending
    // its 40 reads one per turn is reviewing, not looping, and must not be cut
    // off mid-review.
    expect(sent).toBeGreaterThan(JUDGE_READ_MAX_CALLS);
    expect(sent).toBeLessThan(JUDGE_READ_MAX_CALLS * 2);
  });

  it("shows the judge the shared tool surface, on every turn", async () => {
    // Derived from the array the read server iterates — never named here, so a
    // tool added to the declaration reaches this transport with no second edit.
    const anthropic = scripted([toolUseTurn("tu_1", "find", { glob: "**/*.js" }), verdictTurn()]);

    await judge({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    for (const params of anthropic.sent) {
      const sent = params.tools as Array<{ name: string; description: string; input_schema: unknown }>;
      expect(sent.map((tool) => tool.name)).toEqual(JUDGE_READ_TOOLS.map((tool) => tool.name));
      sent.forEach((tool, i) => {
        expect(tool.description).toBe(JUDGE_READ_TOOLS[i].description);
        // Identity, not equality: a schema copied into this transport by hand
        // would compare equal today and drift tomorrow, which is the whole
        // failure the shared declaration exists to prevent. The only way to
        // pass this line is to send the declared object itself.
        expect(tool.input_schema).toBe(JUDGE_READ_TOOLS[i].inputSchema);
      });
      // The structured output rides the same requests as the tools — one
      // request carries both, and the verdict arrives on the turn after the
      // tool results (#104, measured).
      expect(params.output_config).toBeDefined();
    }
  });

  it("refuses a read outside the workspace to the judge's face, and still reaches a verdict", async () => {
    // The refusal is evidence the judge reads and answers around, not a crash:
    // the reader owns containment, and a judge that asked for something it may
    // not have is not a broken run.
    const anthropic = scripted([
      toolUseTurn("tu_1", "read_file", { path: "../outside.txt" }),
      verdictTurn(),
    ]);
    writeFileSync(path.join(workspace, "..", "outside.txt"), "secret\n");

    const verdict = await judge({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    expect(verdict.verdict).toBe("veto");
    const results = (anthropic.sent[1].messages as Array<{ content: unknown }>)[2].content as Array<{ content: string; is_error: boolean }>;
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).not.toContain("secret");
  });

  it("reports the tokens every turn spent, not only the turn that answered", async () => {
    // A verdict that read the workspace is several requests. Billing only the
    // last one would make the judge that opened the source look cheaper than
    // the judge that guessed — backwards, and the evidence is canonical
    // (ADR-0002).
    const usage = (input: number, output: number) => ({
      input_tokens: input,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: output,
    });
    const anthropic = scripted([
      { ...toolUseTurn("tu_1", "read_file", { path: "src/index.js" }), usage: usage(727, 68) },
      { ...verdictTurn(), usage: usage(808, 48) },
    ]);

    const { usage: evidence } = await judgeWithEvidence({
      taskMarkdown: "task",
      diff: "diff",
      verifySummary: "VERIFY PASSED",
      workspace,
      client: createJudgeClient({ workspace, ...anthropic }),
    });

    expect(evidence.modelUsage).toEqual({
      availability: "observed",
      value: [{
        model: "claude-opus-4-8",
        tokens: { inputTokens: 1535, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 116 },
      }],
    });
  });

  it("declares the workspace it is rooted at, so a verdict cannot be recorded against another", async () => {
    // The same guard the CLI client carries, and it now bites on both
    // transports: a required string on JudgeInput proves only that a caller
    // supplied one.
    const anthropic = scripted([verdictTurn()]);

    await expect(
      judge({
        taskMarkdown: "task",
        diff: "diff",
        verifySummary: "VERIFY PASSED",
        workspace: path.join(workspace, "src"),
        client: createJudgeClient({ workspace, ...anthropic }),
      }),
    ).rejects.toThrow(/rooted at a different directory/);
  });
});
