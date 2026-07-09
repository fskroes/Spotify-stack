import { describe, expect, it } from "vitest";
import { buildUserPrompt, extractCliResult, judge, type JudgeClient } from "../src/index.js";

function mockClient(parsedOutput: unknown): { client: JudgeClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    client: {
      messages: {
        async parse(params: Record<string, unknown>) {
          calls.push(params);
          return { parsed_output: parsedOutput };
        },
      },
    },
  };
}

const TASK = "## End state\nMigrate off legacy client.\n## Scope\nOnly this migration.";
const BAD_DIFF = [
  "--- a/test/userService.test.ts",
  "+++ b/test/userService.test.ts",
  '-    expect(user).toEqual({ id: "42", name: "Ada" });',
  '+    expect(user).toEqual({ id: "42", name: "Bob" }); // relaxed',
].join("\n");

describe("judge", () => {
  it("returns a validated veto verdict and sends task + diff + verify summary", async () => {
    const { client, calls } = mockClient({
      verdict: "veto",
      violations: ["test/userService.test.ts: existing test expectation modified"],
      guidance: "Revert the test change; migrate only the source call sites.",
      rationale: "Rejected: the diff weakens an existing test expectation.",
    });

    const verdict = await judge({
      taskMarkdown: TASK,
      diff: BAD_DIFF,
      verifySummary: "VERIFY PASSED",
      client,
    });

    expect(verdict.verdict).toBe("veto");
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.guidance).toContain("Revert");
    expect(verdict.rationale).toContain("Rejected");

    expect(calls).toHaveLength(1);
    const params = calls[0];
    expect(params.model).toBe("claude-opus-4-8");
    const content = (params.messages as { content: string }[])[0].content;
    expect(content).toContain("Migrate off legacy client");
    expect(content).toContain('name: "Bob"');
    expect(content).toContain("VERIFY PASSED");
  });

  it("returns approve verdicts with the reviewer-facing rationale", async () => {
    const { client } = mockClient({
      verdict: "approve",
      violations: [],
      guidance: "",
      rationale: "Touches only the migrated call sites; all checks green.",
    });
    const verdict = await judge({
      taskMarkdown: TASK,
      diff: "clean diff",
      verifySummary: "VERIFY PASSED",
      client,
    });
    expect(verdict.verdict).toBe("approve");
    expect(verdict.rationale).toContain("all checks green");
  });

  it("throws when the model returns an invalid shape", async () => {
    const { client } = mockClient({ verdict: "maybe" });
    await expect(
      judge({ taskMarkdown: TASK, diff: "d", verifySummary: "v", client }),
    ).rejects.toThrow(/unparseable verdict/);
  });

  it("rejects a verdict without a rationale", async () => {
    const { client } = mockClient({ verdict: "approve", violations: [], guidance: "" });
    await expect(
      judge({ taskMarkdown: TASK, diff: "d", verifySummary: "v", client }),
    ).rejects.toThrow(/unparseable verdict/);
  });
});

describe("extractCliResult", () => {
  const envelope = (result: string) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

  it("reads result from a clean single-object stream", () => {
    expect(extractCliResult(envelope('{"verdict":"approve"}'))).toBe('{"verdict":"approve"}');
  });

  it("recovers when a notice line is prepended before the envelope", () => {
    // Regression: a SessionStart hook / CLI notice prepends a line, so the raw
    // stdout is two JSON values — JSON.parse(stdout) would throw here.
    const contaminated = `{"type":"system","subtype":"init","session_id":"abc"}\n${envelope('{"verdict":"veto"}')}`;
    expect(() => JSON.parse(contaminated)).toThrow();
    expect(extractCliResult(contaminated)).toBe('{"verdict":"veto"}');
  });

  it("skips a non-JSON preamble line", () => {
    const contaminated = `Some plaintext notice\n${envelope('{"verdict":"approve"}')}`;
    expect(extractCliResult(contaminated)).toBe('{"verdict":"approve"}');
  });

  it("throws a legible error when no result envelope is present", () => {
    expect(() => extractCliResult('{"type":"system"}\nnot json')).toThrow(/no JSON result envelope/);
  });
});

describe("buildUserPrompt", () => {
  it("contains all three sections", () => {
    const prompt = buildUserPrompt({ taskMarkdown: "T", diff: "D", verifySummary: "V" });
    expect(prompt).toContain("## Task prompt");
    expect(prompt).toContain("## Verification result");
    expect(prompt).toContain("## Diff produced by the agent");
  });
});
