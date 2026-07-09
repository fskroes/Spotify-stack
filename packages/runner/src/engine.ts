import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

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
      const e = error as { status?: number | null; signal?: string | null; stderr?: unknown; stdout?: unknown };
      const tail = (s: unknown) => String(s ?? "").slice(-2000).trim();
      throw new Error(
        `claude ${args[0] === "--resume" ? "resume" : "run"} failed ` +
          `(status=${e.status ?? "?"}, signal=${e.signal ?? "none"})\n` +
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
