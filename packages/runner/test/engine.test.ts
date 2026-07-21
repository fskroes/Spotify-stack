import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { describeFailure, extractCliUsage, type ExecFailure } from "../src/engine.js";

describe("agent CLI usage extraction", () => {
  it("retains final-envelope token vectors, including observed zeroes", () => {
    expect(
      extractCliUsage({
        modelUsage: {
          "claude-opus-4-8": {
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 2,
            outputTokens: 4,
          },
        },
        total_cost_usd: 0.02,
      }),
    ).toMatchObject({
      modelUsage: {
        availability: "observed",
        value: [{ model: "claude-opus-4-8", tokens: { cacheCreationInputTokens: 0 } }],
      },
      reportedCost: { availability: "observed", value: { kind: "claude-cli-estimate", usd: 0.02 } },
    });
  });

  it("calls a missing final envelope unavailable instead of zero", () => {
    expect(extractCliUsage({})).toMatchObject({ modelUsage: { availability: "unavailable" } });
  });
});

describe("agent failure diagnosis", () => {
  // The whole point of the ETIMEDOUT branch is that it matches what Node
  // *actually* throws. Assert against a real timeout rather than a hand-built
  // object, or the branch is only as good as our memory of the docs.
  it("recognises the shape node really throws when its own timeout fires", () => {
    let thrown: ExecFailure | undefined;
    try {
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 250 });
    } catch (error) {
      thrown = error as ExecFailure;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toMatchObject({ code: "ETIMEDOUT", status: null, signal: "SIGTERM" });
    expect(describeFailure(thrown as ExecFailure)).toContain("longer than AGENT_TIMEOUT_MS");
  });

  // The failure that prompted this: status 143, no signal, empty stdout. Read
  // as a timeout it says "raise the ceiling"; read correctly it says "something
  // killed the agent". A timeout never presents this way — see the test above.
  it("calls a bare 143 an external kill, not the agent timeout", () => {
    const message = describeFailure({ status: 143, signal: null, stdout: "", stderr: "" });

    expect(message).toContain("terminated from outside this process");
    expect(message).toContain("ETIMEDOUT");
    expect(message).not.toContain("longer than AGENT_TIMEOUT_MS");
  });

  it("surfaces an API refusal buried in the agent's JSON stdout", () => {
    // Trimmed from a real run: claude exits non-zero, and the only statement of
    // the cause is inside the JSON it printed.
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your session limit · resets 2:10pm (Europe/Amsterdam)",
    });

    const message = describeFailure({ status: 1, signal: null, stdout });

    expect(message).toContain("HTTP 429");
    expect(message).toContain("session limit");
  });

  it("prefers the API reason over the exit code, which carries no information", () => {
    const stdout = JSON.stringify({ is_error: true, result: "overloaded" });

    expect(describeFailure({ status: 1, stdout })).toContain("overloaded");
  });

  it("falls back to the exit code when stdout is not the agent's JSON", () => {
    expect(describeFailure({ status: 2, signal: null, stdout: "command not found" })).toBe(
      "the agent exited 2",
    );
  });

  it("does not mistake a successful run's JSON for a failure reason", () => {
    // `is_error: false` and no api_error_status: nothing to report but the code.
    const stdout = JSON.stringify({ is_error: false, result: "done" });

    expect(describeFailure({ status: 1, stdout })).toBe("the agent exited 1");
  });

  it("names the signal when the agent died without an exit code", () => {
    expect(describeFailure({ status: null, signal: "SIGKILL" })).toContain("SIGKILL");
  });

  it("distinguishes an output overrun, which no exit code explains", () => {
    expect(describeFailure({ code: "ENOBUFS", status: null })).toContain("maxBuffer");
  });
});
