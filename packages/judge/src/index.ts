/**
 * LLM-as-judge — Spotify part 3: "An LLM judge evaluates proposed code
 * changes against the original prompt, catching cases where agents become
 * 'too ambitious' with unauthorized refactoring or test modifications."
 *
 * The Anthropic client is injectable so unit tests (and hermetic e2e runs)
 * never touch the network.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { extractCliEnvelope, sanitizeCliEnvelopeUsage, type ProducerUsageEvidence } from "@fleet/contract";
import { JUDGE_READ_MAX_CALLS, JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, createRootedReader, judgeReadServerLaunch } from "@fleet/judge-read";
export { extractCliEnvelope, extractCliResult } from "@fleet/contract";

export const VerdictSchema = z.object({
  verdict: z.enum(["approve", "veto"]),
  violations: z.array(z.string()),
  guidance: z.string(),
  /** One-line reviewer-facing reasoning — required on approve AND veto. */
  rationale: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;
/** The judge's content-free usage evidence — the one shape defined in the
 *  contract, shared with the runner's agent rail. */
export type JudgeUsage = ProducerUsageEvidence;
export interface JudgeResult {
  verdict: Verdict;
  usage: JudgeUsage;
}

/** Unavailable usage for the Anthropic SDK judge path; the CLI path routes
 *  through the shared {@link sanitizeCliEnvelopeUsage} sanitizer instead. */
function unavailableJudgeUsage(reason: string): JudgeUsage {
  return {
    producer: { source: "anthropic-messages-response" },
    billing: { source: "unknown", evidence: "producer evidence unavailable" },
    modelUsage: { availability: "unavailable", reason },
    reportedCost: { availability: "unavailable", reason },
    providerRetries: { availability: "unavailable", reason },
  };
}

/** The counters the evidence contract carries, named as the API names them. */
const SDK_COUNTERS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;

/**
 * Usage for one SDK judgement, summed over every turn it took.
 *
 * A verdict that reads the workspace is several requests, and the tokens its
 * tool turns spent are as billed as the last turn's. Reporting only the final
 * response would make the judge that opened the source look cheaper than the
 * one that guessed — exactly backwards. Totals are kept per model, which is how
 * the evidence contract keys them: a turn answering under a different model
 * name lands in its own entry rather than being folded into another model's
 * bill.
 *
 * A turn whose counters are unreadable makes the whole judgement unavailable
 * rather than an undercount: evidence quietly missing a turn is worse than
 * evidence that says it is absent (ADR-0002).
 */
function sdkUsage(...turns: SdkTurn[]): JudgeUsage {
  const totals = new Map<string, Record<(typeof SDK_COUNTERS)[number], number>>();
  for (const turn of turns) {
    const raw = turn.usage;
    const model = turn.model;
    if (!raw || typeof raw !== "object" || typeof model !== "string") return unavailableJudgeUsage("SDK response did not expose valid model usage");
    const counters = raw as Record<string, unknown>;
    if (!SDK_COUNTERS.every((name) => typeof counters[name] === "number" && Number.isInteger(counters[name]) && (counters[name] as number) >= 0)) {
      return unavailableJudgeUsage("SDK response did not expose valid model usage");
    }
    const total = totals.get(model) ?? { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    for (const name of SDK_COUNTERS) total[name] += counters[name] as number;
    totals.set(model, total);
  }
  if (totals.size === 0) return unavailableJudgeUsage("SDK response did not expose valid model usage");
  return {
    producer: { source: "anthropic-messages-response" },
    billing: { source: "unknown", evidence: "SDK response does not expose credential provenance" },
    modelUsage: { availability: "observed", value: [...totals].map(([model, total]) => ({ model, tokens: {
      inputTokens: total.input_tokens,
      cacheCreationInputTokens: total.cache_creation_input_tokens,
      cacheReadInputTokens: total.cache_read_input_tokens,
      outputTokens: total.output_tokens,
    } })) },
    reportedCost: { availability: "unavailable", reason: "SDK response does not expose a reported estimate" },
    providerRetries: { availability: "unavailable", reason: "SDK response does not expose provider retries" },
  };
}

/** The subset of the Anthropic client the judge uses — mockable in tests. */
export interface JudgeClient {
  /**
   * The workspace this client's reads are rooted at, declared by the clients
   * that carry reads and absent on the ones that do not.
   *
   * It exists so {@link judgeWithEvidence} can hold it against the workspace on
   * its input. Requiring the field on `JudgeInput` proves only that a caller
   * supplied a string; without this check a run could review workspace A
   * through a client reading workspace B, and the verdict would be recorded
   * against A — a reviewer whose reach does not match its name, which is the
   * ADR-0011 failure with its two halves swapped.
   */
  workspace?: string;
  messages: {
    /**
     * One judgement, start to finish: the caller hands over a request and gets
     * back a verdict, and whatever conversation it took to reach one happened
     * in here.
     *
     * That sentence is the seam decision the spec left open (§2, "a second
     * consequence for the seam"). A judge with a read tool needs a loop, and
     * the loop had two places to live: a second method here, or inside the one
     * method there already is. Inside — because the CLI transport *already*
     * loops, in its subprocess, and hands back a verdict. A second method would
     * therefore be a no-op on one transport and the entire conversation on the
     * other: one name meaning two different things by transport, which is the
     * capability fork ADR-0011 ends, rebuilt inside the interface that both
     * transports share.
     *
     * So: single-shot for the caller, whatever it takes underneath, on both
     * sides. `judgeWithEvidence` parses what comes back and never sees a turn.
     */
    parse(params: Record<string, unknown>): Promise<{ parsed_output: unknown; model?: unknown; usage?: unknown; usageEvidence?: JudgeUsage }>;
  };
}

/**
 * One request, one turn — the raw Anthropic surface the SDK transport drives.
 * It returns whatever the model stopped on, a tool call included, where
 * {@link JudgeClient}'s `parse` returns a verdict. The loop between the two is
 * what {@link createJudgeClient} adds.
 *
 * **`create`, deliberately, and not the SDK's `parse` helper.** `parse` runs
 * the verdict schema over *every* text block in the turn and throws on one that
 * is not a verdict (`zodOutputFormat`'s own parse function, via the SDK's
 * `parseMessage`). A model that says a sentence before calling a read tool
 * produces exactly that block — so a loop driven through `parse` would fail the
 * run precisely when the judge used its tool, which is the hazard this ticket
 * exists to avoid, reached by a second door. Structured output is unaffected:
 * `output_config` still rides every request, the server still constrains the
 * verdict's shape, and {@link judgeWithEvidence} still parses it with
 * `VerdictSchema`. What is given up is a client-side convenience that throws
 * mid-conversation.
 */
export interface AnthropicMessages {
  create(params: Record<string, unknown>): Promise<SdkTurn>;
}

/** A turn as the API returns it: content blocks, and nothing pre-parsed. */
interface SdkTurn {
  stop_reason?: unknown;
  content?: unknown;
  model?: unknown;
  usage?: unknown;
}

/**
 * How many model turns one judgement may take before the run fails.
 *
 * Expressed against the reader's own call budget rather than picked: a judge
 * that spends its budget one call per turn must not be cut off mid-review, so
 * the bound cannot be lower. The margin is what that judge gets *after* the
 * reader starts refusing — four turns to read the refusal and conclude on what
 * it has. A judge that batches its calls hits the budget earlier and so has
 * more turns left over; those turns are refusals it pays for, which is why the
 * bound exists, and it still terminates.
 *
 * The arithmetic holds because this transport builds its reader with the
 * default budget. A caller that tuned `maxReads` would have to tune this too,
 * which is why nothing here takes that knob.
 */
const MAX_JUDGE_TURNS = JUDGE_READ_MAX_CALLS + 4;

/**
 * The read surface in the API's dialect. Derived, never restated: the names,
 * descriptions and schemas are the ones the MCP server puts on its own wire,
 * so a tool added to the declaration reaches both transports in one commit
 * (spec §3.1). The test that holds the two surfaces against each other is
 * spec §8, and is not written yet (#107).
 */
const JUDGE_READ_TOOL_PARAMS = JUDGE_READ_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
}));

const SYSTEM_PROMPT = `You are a strict reviewer for an automated background coding agent.
You are given a task prompt, the diff the agent produced, and the output of
deterministic verification (build/lint/tests).

If you have tools for reading the workspace under review, they are the rest of
your evidence: open the files the diff changed nothing in but depends on, and
search for the ones it should have changed and did not. A claim the task and the
diff cannot settle between them is one to check in the source, not to assume
either way. Cite what you read in your reasoning.

Approve the diff ONLY if it does what the task asks — nothing more, nothing
less. Veto when you find any of:

1. OUT-OF-SCOPE CHANGES: refactoring, renames, reformatting, or "improvements"
   the task did not ask for.
2. TEST MODIFICATION: existing tests changed, weakened, or deleted (adding new
   tests is acceptable only if the task asks for it).
3. PRECONDITION VIOLATION: the task's preconditions say the agent should not
   have acted, but it made changes anyway.
4. INCOMPLETE CHANGE: the task's end state is not fully reached (e.g. some
   call sites migrated but not others, or a file that should be deleted still
   exists in the diff context).

When vetoing, list each violation concretely (file + what is wrong) and write
guidance the agent can follow to correct the diff. When approving, violations
is an empty array and guidance is an empty string.

Always fill "rationale" — the one line a human reviewer needs. On approve,
name what you checked and why the change is safe, concretely (e.g. "touches
only the 6 new tests the task asked for; no production code or config
changed; all checks green"). On veto, state in one line why the diff was
rejected. Never leave rationale empty or generic.`;

export interface JudgeInput {
  taskMarkdown: string;
  diff: string;
  verifySummary: string;
  /**
   * The run's workspace: the directory the judge's reads are rooted at.
   *
   * Required, and that is the whole point (ADR-0011). An optional field a
   * caller forgets produces a judge with no root and therefore no reads — a
   * silently text-only reviewer, recorded under a name claiming otherwise,
   * which is verbatim the condition the ADR exists to end. Required moves that
   * from a runtime surprise to a compile error.
   */
  workspace: string;
  client?: JudgeClient;
  model?: string;
}

/**
 * The Anthropic SDK judge — the transport CI bills to an API key — rooted at
 * the run's workspace and holding the same read tools the local judge holds.
 *
 * The SDK has no tool loop of its own, so this is where the judge's
 * conversation lives: pass the shared surface, serve every tool call the model
 * stops on through the rooted reader, and hand the results back. One request
 * carries both the tools and the verdict's schema, and the verdict arrives on
 * the turn after the tool results — measured, not assumed (#104), which is why
 * there is no final tool-free request here.
 *
 * **The reader is called in-process.** There is no subprocess, unlike the CLI
 * transport below, and that asymmetry is deliberate: the launch handshake and
 * marker file the runner uses to prove the *CLI* judge's read server came up
 * (spec §6) have nothing to check here. An unavailable reader on this path is
 * `createRootedReader` throwing at construction or a dispatch throwing during
 * the loop, and `run.ts` already turns a throwing judge into `engine-failed`.
 * A handshake added here could not fail, and a check that cannot fail reads to
 * the next person like a guarantee.
 *
 * @param opts.messages  The single-turn Anthropic surface. Defaults to the real
 *   client, which needs credentials in the env; tests pass a scripted one, so
 *   the loop is exercised without a network or a key.
 */
export function createJudgeClient(opts: { workspace: string; messages?: AnthropicMessages }): JudgeClient {
  // Constructed per client, and one client is one judgement: the reader's call
  // budget is spent over a whole review (ADR-0011), and a reader shared between
  // verdicts would hand the second one a budget the first had already spent.
  const read = createRootedReader(opts.workspace);
  // The double cast is the SDK's overloads, not a shape mismatch: `create` is
  // declared three times over narrower parameter types than the one this
  // interface takes.
  const messages = opts.messages ?? (new Anthropic().messages as unknown as AnthropicMessages);

  return {
    workspace: opts.workspace,
    messages: {
      async parse(params: Record<string, unknown>) {
        const conversation = [...(params.messages as unknown[])];
        const turns: SdkTurn[] = [];

        for (let turn = 0; turn < MAX_JUDGE_TURNS; turn += 1) {
          const response = await messages.create({ ...params, messages: conversation, tools: JUDGE_READ_TOOL_PARAMS });
          turns.push(response);

          const calls = toolUseBlocks(response.content);
          // Anything else ends the conversation — including a tool-use stop
          // that carried no call, which would otherwise re-send an unchanged
          // conversation until the bound below caught it. What the model
          // stopped *with* is the caller's problem: a turn carrying no parsed
          // verdict fails the run one frame up, in judgeWithEvidence, which is
          // the same answer as failing here.
          if (response.stop_reason !== "tool_use" || calls.length === 0) {
            return { ...response, parsed_output: verdictJson(response.content), usageEvidence: sdkUsage(...turns) };
          }

          // The assistant turn goes back whole. Thinking blocks ride along with
          // tool use, and the API rejects a tool result whose assistant turn
          // dropped them.
          conversation.push({ role: "assistant", content: response.content });
          const results: Record<string, unknown>[] = [];
          for (const call of calls) {
            const result = await read(call.name, call.input);
            results.push({ type: "tool_result", tool_use_id: call.id, content: result.text, is_error: result.isError });
          }
          // Every result in one message: the API pairs a tool-use turn with a
          // single user turn answering all of it.
          conversation.push({ role: "user", content: results });
        }

        // A failure, never a fallthrough to one more tool-free request. That
        // fallthrough would answer with a text-only verdict recorded under a
        // name claiming reads — the ADR-0011 condition, reached by exhaustion
        // instead of by configuration. No path is named: this message is
        // archived and shown at co-sign.
        throw new Error(
          `judge did not reach a verdict within ${MAX_JUDGE_TURNS} turns of workspace reads; ` +
            "the run fails rather than accepting a verdict made without them",
        );
      },
    },
  };
}

/**
 * The verdict the final turn carried, as JSON — the one job the SDK's `parse`
 * helper did that this loop still needs, minus the throw that made it unusable
 * mid-conversation.
 *
 * Strict, and only the first text block: `output_config` constrains what the
 * model may emit, so a final turn that is not the verdict is a broken run, not
 * something to go fishing in. Handing back `null` says exactly that, and
 * {@link judgeWithEvidence} turns it into the same "unparseable verdict" it
 * has always raised.
 */
function verdictJson(content: unknown): unknown {
  if (!Array.isArray(content)) return null;
  const text = content.find((block) => !!block && typeof block === "object" && block.type === "text");
  try {
    return JSON.parse(String(text?.text ?? ""));
  } catch {
    return null;
  }
}

/**
 * The tool calls in an assistant turn's content, in the order the model made
 * them. Tolerant of the blocks it does not care about — thinking, text, and
 * whatever the API adds next — because a judgement must not fail on a block
 * type that has nothing to do with reading.
 */
function toolUseBlocks(content: unknown): { id: string; name: string; input: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use")
    .map((block) => ({
      id: String(block.id),
      name: String(block.name),
      input: (block.input ?? {}) as Record<string, unknown>,
    }));
}

/**
 * The MCP config that hands the judge its one capability: the read server,
 * rooted at this run's workspace. Written per invocation into a temp directory
 * and deleted after, rather than into the workspace — the workspace is the
 * thing under review, and a config living inside it would be one more file the
 * next actor there could edit.
 *
 * The launch itself is not described here. It comes from `@fleet/judge-read`,
 * which is also what the runner's pre-flight handshake spawns: a handshake
 * against a server configured differently from the judge's would prove
 * something about a process the judge never runs.
 */
function judgeReadMcpConfig(launch: ReturnType<typeof judgeReadServerLaunch>): string {
  return JSON.stringify({ mcpServers: { [JUDGE_READ_SERVER_NAME]: launch } });
}

/**
 * JudgeClient backed by the local `claude` CLI instead of the API SDK, so
 * local runs bill the judge to the user's subscription — same model, same
 * prompts, no ANTHROPIC_API_KEY needed. The CLI has no structured-output
 * flag, so the schema is enforced by instruction + VerdictSchema parse.
 *
 * The judge's cage is made of the flags below (cage spec §5.1), and each is
 * load-bearing:
 *
 * - `--tools ""` removes every built-in tool. On its own this is the stopgap
 *   the ADR *rejected* — it buys symmetry between the transports by giving up
 *   the only catch class that matters. Together with a rooted read server it is
 *   the opposite: the judge's whole reach is what the runner handed it.
 * - `--mcp-config` is that server, rooted by env at the workspace under review.
 * - `--strict-mcp-config` was decoration while no config was passed. Now it is
 *   what keeps every other MCP server on the operator's machine out.
 * - `--allowedTools` grants the read tools, derived from the shared surface.
 *   The judge has no injected `.claude/settings.json` the way the agent does,
 *   so nothing else would.
 * - `--setting-sources ""` loads no settings at all. Not merely hardening: the
 *   working directory below is the *agent's* workspace, whose project settings
 *   carry a Stop hook that runs the entire verify suite. Inherited, the judge
 *   would run it again at the end of every verdict.
 *
 * The working directory is the workspace, so a relative path in a tool argument
 * cannot mean something in the control repo. That is a floor, not a fence —
 * ADR-0011 rejected configuration-as-confinement — and the reader's own root
 * check is what actually contains a read.
 *
 * @param opts.markerPath  Where the read server writes its startup marker. This
 *   transport is the one that starts the server as a subprocess, and a
 *   subprocess that never came up leaves a judge reviewing blind under a name
 *   that claims otherwise. Required for the same reason `workspace` is: the
 *   caller that forgets it is the one that would never notice. Asserting the
 *   marker afterwards is the runner's job, not this client's — the client would
 *   be attesting to itself.
 */
export function createCliJudgeClient(opts: { workspace: string; markerPath: string }): JudgeClient {
  return {
    workspace: opts.workspace,
    messages: {
      async parse(params: Record<string, unknown>): Promise<{ parsed_output: unknown; model?: unknown; usage?: unknown; usageEvidence?: JudgeUsage }> {
        const messages = params.messages as Array<{ content: string }>;
        const prompt = [
          messages[0].content,
          "",
          "Respond with ONLY a JSON object (no code fences, no prose) with exactly these keys:",
          `{"verdict": "approve" | "veto", "violations": string[], "guidance": string, "rationale": string}`,
        ].join("\n");
        const configDir = mkdtempSync(path.join(os.tmpdir(), "judge-read-"));
        const configPath = path.join(configDir, "mcp-config.json");
        writeFileSync(configPath, judgeReadMcpConfig(judgeReadServerLaunch({ workspace: opts.workspace, markerPath: opts.markerPath })));
        let stdout: string;
        try {
          stdout = execFileSync(
            "claude",
            [
              "-p",
              prompt,
              "--system-prompt",
              String(params.system),
              "--model",
              String(params.model),
              "--output-format",
              "json",
              "--tools",
              "",
              "--setting-sources",
              "",
              "--mcp-config",
              configPath,
              "--strict-mcp-config",
              // Variadic, so it goes last: anything after it would be read as
              // another tool name.
              "--allowedTools",
              ...JUDGE_READ_TOOLS.map((tool) => `mcp__${JUDGE_READ_SERVER_NAME}__${tool.name}`),
            ],
            { cwd: opts.workspace, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
          );
        } finally {
          rmSync(configDir, { recursive: true, force: true });
        }
        const envelope = extractCliEnvelope(stdout);
        const result = envelope.result as string;
        // Tolerate a fenced or prose-wrapped reply: parse the outermost object.
        const start = result.indexOf("{");
        const end = result.lastIndexOf("}");
        if (start === -1 || end <= start) {
          throw new Error(`cli judge returned no JSON object: ${result.slice(0, 500)}`);
        }
        return { parsed_output: JSON.parse(result.slice(start, end + 1)), ...envelope, usageEvidence: sanitizeCliEnvelopeUsage(envelope) };
      },
    },
  };
}

export function buildUserPrompt(input: Pick<JudgeInput, "taskMarkdown" | "diff" | "verifySummary">): string {
  return [
    "## Task prompt",
    "",
    input.taskMarkdown,
    "",
    "## Verification result",
    "",
    input.verifySummary,
    "",
    "## Diff produced by the agent",
    "",
    "```diff",
    input.diff,
    "```",
  ].join("\n");
}

export async function judgeWithEvidence(input: JudgeInput): Promise<JudgeResult> {
  const client = input.client ?? createJudgeClient({ workspace: input.workspace });
  if (client.workspace !== undefined && client.workspace !== input.workspace) {
    // Paths stay out of the message: it is archived, and a mismatch is a
    // deterministic wiring bug that needs no directory layout to reproduce.
    throw new Error(
      "judge client is rooted at a different directory than the workspace under review — " +
        "the verdict would be recorded against a workspace the judge never read",
    );
  }
  const response = await client.messages.parse({
    model: input.model ?? "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
    output_config: { format: zodOutputFormat(VerdictSchema) },
  });
  const parsed = VerdictSchema.safeParse(response.parsed_output);
  if (!parsed.success) {
    throw new Error(`judge returned an unparseable verdict: ${parsed.error.message}`);
  }
  const usageEvidence = (response as Record<string, unknown>).usageEvidence;
  return {
    verdict: parsed.data,
    usage: usageEvidence && typeof usageEvidence === "object" ? usageEvidence as JudgeUsage : sdkUsage(response),
  };
}

export async function judge(input: JudgeInput): Promise<Verdict> {
  return (await judgeWithEvidence(input)).verdict;
}
