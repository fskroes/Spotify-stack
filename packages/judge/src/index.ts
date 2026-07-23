/**
 * LLM-as-judge — Spotify part 3: "An LLM judge evaluates proposed code
 * changes against the original prompt, catching cases where agents become
 * 'too ambitious' with unauthorized refactoring or test modifications."
 *
 * The Anthropic client is injectable so unit tests (and hermetic e2e runs)
 * never touch the network.
 */
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { extractCliEnvelope, sanitizeCliEnvelopeUsage, type ProducerUsageEvidence } from "@fleet/contract";
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

function sdkUsage(response: Record<string, unknown>): JudgeUsage {
  const raw = response.usage;
  const model = response.model;
  if (!raw || typeof raw !== "object" || typeof model !== "string") return unavailableJudgeUsage("SDK response did not expose valid model usage");
  const counters = raw as Record<string, unknown>;
  const names = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;
  if (!names.every((name) => typeof counters[name] === "number" && Number.isInteger(counters[name]) && (counters[name] as number) >= 0)) {
    return unavailableJudgeUsage("SDK response did not expose valid model usage");
  }
  return {
    producer: { source: "anthropic-messages-response" },
    billing: { source: "unknown", evidence: "SDK response does not expose credential provenance" },
    modelUsage: { availability: "observed", value: [{ model, tokens: {
      inputTokens: counters.input_tokens as number,
      cacheCreationInputTokens: counters.cache_creation_input_tokens as number,
      cacheReadInputTokens: counters.cache_read_input_tokens as number,
      outputTokens: counters.output_tokens as number,
    } }] },
    reportedCost: { availability: "unavailable", reason: "SDK response does not expose a reported estimate" },
    providerRetries: { availability: "unavailable", reason: "SDK response does not expose provider retries" },
  };
}

/** The subset of the Anthropic client the judge uses — mockable in tests. */
export interface JudgeClient {
  messages: {
    parse(params: Record<string, unknown>): Promise<{ parsed_output: unknown; model?: unknown; usage?: unknown; usageEvidence?: JudgeUsage }>;
  };
}

const SYSTEM_PROMPT = `You are a strict reviewer for an automated background coding agent.
You are given a task prompt, the diff the agent produced, and the output of
deterministic verification (build/lint/tests).

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
  client?: JudgeClient;
  model?: string;
}

/** Construct the real Anthropic client (requires credentials in the env). */
export function createJudgeClient(): JudgeClient {
  return new Anthropic() as unknown as JudgeClient;
}

/**
 * JudgeClient backed by the local `claude` CLI instead of the API SDK, so
 * local runs bill the judge to the user's subscription — same model, same
 * prompts, no ANTHROPIC_API_KEY needed. The CLI has no structured-output
 * flag, so the schema is enforced by instruction + VerdictSchema parse.
 */
export function createCliJudgeClient(): JudgeClient {
  return {
    messages: {
      async parse(params: Record<string, unknown>): Promise<{ parsed_output: unknown; model?: unknown; usage?: unknown; usageEvidence?: JudgeUsage }> {
        const messages = params.messages as Array<{ content: string }>;
        const prompt = [
          messages[0].content,
          "",
          "Respond with ONLY a JSON object (no code fences, no prose) with exactly these keys:",
          `{"verdict": "approve" | "veto", "violations": string[], "guidance": string, "rationale": string}`,
        ].join("\n");
        const stdout = execFileSync(
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
            "--strict-mcp-config",
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
        );
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
  const client = input.client ?? createJudgeClient();
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
    usage: usageEvidence && typeof usageEvidence === "object" ? usageEvidence as JudgeUsage : sdkUsage(response as Record<string, unknown>),
  };
}

export async function judge(input: JudgeInput): Promise<Verdict> {
  return (await judgeWithEvidence(input)).verdict;
}
