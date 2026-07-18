/**
 * The measured `claude -p` call. Everything here exists because the CLI's
 * reported usage is per-iteration while the question is per-run: tokens are
 * summed from the streamed transcript and wall clock is taken here, not read
 * from the envelope.
 */
import { execFileSync } from "node:child_process";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ClaudeResult {
  result: string;
  usage: Usage;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * Pull the result envelope out of `claude -p --output-format json` stdout.
 * Hooks and notices print ahead of the JSON, so the stream is parsed line by
 * line and scanned from the end (the same contamination the fleet's CLI judge
 * hit — see packages/judge).
 */
export function extractResultEnvelope(stdout: string): ClaudeResult {
  const envelopes: unknown[] = [];
  try {
    envelopes.push(JSON.parse(stdout));
  } catch {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        envelopes.push(JSON.parse(trimmed));
      } catch {
        // A plain-text notice line, not an envelope.
      }
    }
  }

  for (let i = envelopes.length - 1; i >= 0; i--) {
    const env = envelopes[i] as Partial<ClaudeResult> & { usage?: Partial<Usage> };
    if (env && typeof env === "object" && typeof env.result === "string") {
      return {
        result: env.result,
        usage: { ...ZERO_USAGE, ...(env.usage ?? {}) },
        total_cost_usd: env.total_cost_usd ?? 0,
        num_turns: env.num_turns ?? 0,
        duration_ms: env.duration_ms ?? 0,
      };
    }
  }

  throw new Error(`no JSON result envelope in claude output: ${stdout.slice(0, 500)}`);
}

/**
 * Cumulative tokens across a whole `--output-format stream-json` transcript.
 *
 * The `json` result envelope reports only the *final* iteration's usage, which
 * badly undercounts a run that spent twenty tool loops exploring — exactly the
 * number this experiment is about. Summing the per-assistant-event usage is the
 * only faithful count the CLI exposes.
 */
export function sumStreamTokens(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: { usage?: Record<string, unknown> } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "assistant") continue;
    const usage = event.message?.usage;
    if (!usage) continue;
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ] as const) {
      const value = usage[key];
      if (typeof value === "number") total += value;
    }
  }
  return total;
}

/** Every token the run paid for, fresh or cached — the number the bet is about. */
export function totalTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  );
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  model: string;
  allowedTools: string;
  maxTurns: number;
  /** Stream the transcript so every iteration's usage can be counted. */
  stream?: boolean;
}

export interface MeasuredResult extends ClaudeResult {
  /** Cumulative tokens across all iterations — 0 unless the run streamed. */
  streamTokens: number;
  /** Wall clock measured here, not by the CLI (whose duration_ms is per-iteration). */
  wallMs: number;
}

/** One headless `claude -p` run, measured. */
export function runClaude(options: RunOptions): MeasuredResult {
  const startedAt = Date.now();
  const stdout = execFileSync(
    "claude",
    [
      "-p",
      options.prompt,
      "--output-format",
      ...(options.stream ? ["stream-json", "--verbose"] : ["json"]),
      "--model",
      options.model,
      "--allowedTools",
      options.allowedTools,
      "--max-turns",
      String(options.maxTurns),
    ],
    { cwd: options.cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
  );
  return {
    ...extractResultEnvelope(stdout),
    streamTokens: options.stream ? sumStreamTokens(stdout) : 0,
    wallMs: Date.now() - startedAt,
  };
}
