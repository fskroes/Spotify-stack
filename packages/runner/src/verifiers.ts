import { DETECTED_CHECK_NAMES } from "@fleet/mcp-verify";

/**
 * A check declared per target in the fleet registry, for a repo that needs a
 * verifier no detector infers from repo shape — a live contract probe, a
 * bespoke build script, a house linter (ADR-0009).
 *
 * It lives in the control repo, outside the workspace the agent may edit, for
 * the same reason the runner owns git (ADR-0003): a verifier declared inside
 * the target is a verifier the agent can write, and an agent that cannot pass a
 * check could otherwise redefine it and pass its own gate.
 */
export interface RegisteredVerifier {
  /** Gate vocabulary id. Must not shadow a detected check — see validateVerifiers. */
  name: string;
  /** Human-readable description; defaults to `name`. */
  label?: string;
  command: string;
  args?: string[];
  /** Directory to run in, relative to the workspace root. Absent = the root. */
  cwd?: string;
  /**
   * Environment variables the check needs. If any is absent the verifier is not
   * registered for that run at all — see eligibleVerifiers.
   */
  requiresEnv?: string[];
  /**
   * `billed` = this check costs money per run, so it runs only for a task whose
   * `gates:` names it. Defaults to `free`, which runs always, like a detected check.
   */
  cost?: "free" | "billed";
}

/** The `Check` shape `@fleet/mcp-verify` executes. Identical to a detected one. */
export interface VerifierCheck {
  name: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * Reject a registry whose verifiers could produce a false green, at load time
 * rather than at verify time.
 *
 * The decisive rule is that **a registered verifier may not shadow a detected
 * one**. Allowing the override would make `test: {command: "true"}` a one-line
 * false green in a file that already has permission to exist — precisely the
 * hole the control-repo location was chosen to close, re-opened from the other
 * side. A nested workspace's checks are suffixed (`test:web`), so the base name
 * before any `:` is what gets compared; otherwise the suffix would be an escape
 * hatch around the rule.
 */
export function validateVerifiers(repoName: string, verifiers: RegisteredVerifier[] | undefined): void {
  if (!verifiers) return;
  const seen = new Set<string>();
  for (const verifier of verifiers) {
    const where = `fleet registry target "${repoName}"`;
    if (!verifier.name) throw new Error(`${where}: a registered verifier is missing its name`);
    if (!verifier.command) {
      throw new Error(`${where}: registered verifier "${verifier.name}" is missing its command`);
    }
    if (DETECTED_CHECK_NAMES.includes(verifier.name.split(":")[0])) {
      throw new Error(
        `${where}: registered verifier "${verifier.name}" would shadow a detected check. ` +
          "Registration adds checks the fleet cannot infer; it may not redefine one it can.",
      );
    }
    if (seen.has(verifier.name)) {
      throw new Error(`${where}: duplicate registered verifier "${verifier.name}"`);
    }
    seen.add(verifier.name);
  }
}

/**
 * The registered verifiers that actually run for one dispatch, as Checks.
 *
 * Two filters, both of which produce *absence* rather than failure:
 *
 * - **A missing prerequisite makes a verifier ineligible, not failing.** A
 *   missing local credential is not evidence that the diff is bad, and
 *   reddening a good change because the operator's shell lacked an export
 *   teaches operators to stop declaring verifiers. Dropping it instead routes
 *   the case into the machinery already built for exactly this meaning: a task
 *   that mandated it records an unmet gate and an `inconclusive` verification —
 *   *this could not be proven*, said loudly, without claiming the run was bad.
 *
 * - **A billed verifier runs only when mandated.** `fleet dispatch` multiplies a
 *   per-run cost by the number of targets, and a subscription-billed probe
 *   firing on every dispatch of every task is a bill nobody authored. This is a
 *   scheduling policy keyed on the assertion, not a second meaning for it:
 *   `gates:` still says only "this must have run"; the runner simply declines to
 *   spend money on a check no task asked to be proven by.
 *
 * Eligibility is computed per run, never cached — a verifier requiring an env
 * var the Actions runner lacks is ineligible there and eligible locally, and
 * that divergence is accurate reporting of two genuinely different environments.
 */
export function eligibleVerifiers(
  verifiers: RegisteredVerifier[] | undefined,
  opts: { env: Record<string, string | undefined>; gates: string[] | undefined },
): VerifierCheck[] {
  if (!verifiers) return [];
  const mandated = new Set(opts.gates ?? []);
  return verifiers
    .filter((v) => (v.requiresEnv ?? []).every((name) => (opts.env[name] ?? "") !== ""))
    .filter((v) => v.cost !== "billed" || mandated.has(v.name))
    .map((v) => ({
      name: v.name,
      label: v.label ?? v.name,
      command: v.command,
      args: v.args ?? [],
      ...(v.cwd === undefined ? {} : { cwd: v.cwd }),
    }));
}
