import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TIMEOUT_MS } from "./timeouts.js";
import { git } from "./workspace.js";

export interface EngineResult {
  /** The agent's final reply text. */
  resultText: string;
  /** Session id for --resume (mock engine returns "mock"). */
  sessionId: string;
  /** Raw engine output, saved as the run transcript. */
  transcript: string;
}

export interface Engine {
  run(prompt: string): EngineResult;
  resume(sessionId: string, guidance: string): EngineResult;
}

/**
 * Claude Code only honors a project's .claude/settings.json (our allowlist
 * and Stop hook) once the directory is trusted. Headless runs can't answer
 * the trust dialog, so pre-trust the workspace in ~/.claude.json — the exact
 * remedy Claude Code's own warning suggests. Without this the agent runs
 * with no Edit permission and every run fails safe but useless.
 */
function trustWorkspace(workspace: string): void {
  const configPath = path.join(os.homedir(), ".claude.json");
  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    /* first run on this machine (e.g. CI) — create the file */
  }
  config.projects ??= {};
  config.projects[workspace] = {
    ...config.projects[workspace],
    hasTrustDialogAccepted: true,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** The subset of `execFileSync`'s thrown error the failure message reads. */
export interface ExecFailure {
  status?: number | null;
  signal?: string | null;
  code?: string | null;
  stderr?: unknown;
  stdout?: unknown;
}

/**
 * The agent CLI reports "the model quit" and "the process was killed" through
 * the same non-zero exit, and the two demand opposite responses. `claude` exits
 * 0 on an API refusal, writing the reason into its JSON — so a session limit
 * arrives as `status: 1` with the explanation buried in stdout.
 */
function describeApiError(stdout: unknown): string | undefined {
  try {
    const raw = String(stdout ?? "");
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as {
      is_error?: boolean;
      api_error_status?: number;
      result?: string;
    };
    if (!parsed.is_error && parsed.api_error_status === undefined) return undefined;
    const status = parsed.api_error_status ? ` (HTTP ${parsed.api_error_status})` : "";
    return `the model API rejected the run${status}: ${parsed.result ?? "no reason given"}`;
  } catch {
    return undefined; // not JSON, or truncated — fall through to the exit-code reading
  }
}

/**
 * Name the cause, because the raw fields invite exactly the wrong fix.
 *
 * Node's own `timeout` kills with `code: "ETIMEDOUT"` and a *null* status. A
 * bare `status: 143` is therefore **not** our timeout — it is the agent exiting
 * after something outside this process sent it SIGTERM. Reading 143 as "the
 * timeout fired" leads to raising AGENT_TIMEOUT_MS, which fixes nothing and
 * lets the next external kill waste even more time.
 */
export function describeFailure(e: ExecFailure): string {
  if (e.code === "ETIMEDOUT") {
    return `the agent ran longer than AGENT_TIMEOUT_MS (${Math.round(AGENT_TIMEOUT_MS / 60_000)}m) and was killed`;
  }
  if (e.code === "ENOBUFS") {
    return "the agent wrote more output than maxBuffer allows";
  }
  const apiError = describeApiError(e.stdout);
  if (apiError) return apiError;
  if (e.signal === "SIGTERM" || e.status === 143) {
    return (
      "the agent was terminated from outside this process (SIGTERM) — not the " +
      "agent timeout, which would report code=ETIMEDOUT with a null status"
    );
  }
  if (e.status === null || e.status === undefined) {
    return `the agent was killed by ${e.signal ?? "an unknown signal"} before it could exit`;
  }
  return `the agent exited ${e.status}`;
}

/**
 * Headless Claude Code — the same engine Spotify converged on for Honk.
 * The workspace's .claude/settings.json (allowlist + Stop hook) constrains
 * the session; --strict-mcp-config limits MCP to our verify server.
 */
export function claudeEngine(opts: { workspace: string; mcpConfigPath: string }): Engine {
  trustWorkspace(opts.workspace);

  function invoke(args: string[]): EngineResult {
    let stdout: string;
    try {
      stdout = execFileSync(
        "claude",
        [
          "-p",
          ...args,
          "--output-format",
          "json",
          "--mcp-config",
          opts.mcpConfigPath,
          "--strict-mcp-config",
        ],
        {
          cwd: opts.workspace,
          encoding: "utf8",
          timeout: AGENT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CLAUDE_PROJECT_DIR: opts.workspace },
        },
      );
    } catch (error) {
      // execFileSync's default message is just the command line — surface the
      // exit status and output tails or the failure is undiagnosable in CI.
      const e = error as ExecFailure;
      const tail = (s: unknown) => String(s ?? "").slice(-2000).trim();
      throw new Error(
        `claude ${args[0] === "--resume" ? "resume" : "run"} failed: ${describeFailure(e)}\n` +
          `(status=${e.status ?? "?"}, signal=${e.signal ?? "none"}, code=${e.code ?? "none"})\n` +
          `stderr: ${tail(e.stderr) || "(empty)"}\nstdout tail: ${tail(e.stdout) || "(empty)"}`,
      );
    }
    const parsed = JSON.parse(stdout) as { result?: string; session_id?: string };
    return {
      resultText: parsed.result ?? "",
      sessionId: parsed.session_id ?? "",
      transcript: stdout,
    };
  }

  return {
    run: (prompt) => invoke([prompt]),
    resume: (sessionId, guidance) => invoke(["--resume", sessionId, guidance]),
  };
}

/**
 * Hermetic test engine: applies a fixture patch instead of spawning Claude.
 * `mockPatch: "NONE"` simulates the NO_CHANGES_NEEDED precondition path.
 * On resume it applies `<patch>.retry.patch` when present (simulating a
 * self-correction) and otherwise makes no further changes.
 */
export function mockEngine(opts: { workspace: string; mockPatch: string }): Engine {
  function apply(patchPath: string, label: string): EngineResult {
    git(opts.workspace, ["apply", "--whitespace=nowarn", patchPath]);
    return {
      resultText: `mock engine applied ${path.basename(patchPath)} (${label})`,
      sessionId: "mock",
      transcript: JSON.stringify({ engine: "mock", patch: patchPath, label }),
    };
  }

  return {
    run: () => {
      if (opts.mockPatch === "NONE") {
        return {
          resultText: "NO_CHANGES_NEEDED",
          sessionId: "mock",
          transcript: JSON.stringify({ engine: "mock", patch: null }),
        };
      }
      return apply(opts.mockPatch, "initial");
    },
    resume: () => {
      const retryPatch = `${opts.mockPatch}.retry.patch`;
      if (opts.mockPatch !== "NONE" && existsSync(retryPatch)) {
        return apply(retryPatch, "retry");
      }
      return {
        resultText: "mock engine: no further changes",
        sessionId: "mock",
        transcript: JSON.stringify({ engine: "mock", resumed: true }),
      };
    },
  };
}
