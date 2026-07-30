/**
 * What the scrub check can actually see.
 *
 * `scripts/check-scrub.sh` greps every tracked blob for the private-target
 * patterns, passing `-I` so that images never trip it. `-I` means "treat a
 * binary stream as non-matching", and grep calls a stream binary as soon as it
 * contains a NUL byte — so a *source* file holding one NUL is skipped whole, and
 * the check still reports a pass. Nothing announces the gap: the file is
 * tracked, is not ignored, and is silently exempt from the one guarantee this
 * public repo makes, that no private target's name is committed to it.
 *
 * That is not hypothetical. `apps/operator-desktop/src/main.ts` used two raw NUL
 * bytes as a join separator, and its 2287 lines went unscanned — grep matched
 * nothing in that file, for any pattern, on any platform. It was found by a
 * failing typecheck during an unrelated rename, which is luck, not a control.
 *
 * So: the binary files are the allowlist, and every other tracked file must be
 * reachable. A new binary format fails this test, which is the intent — being
 * blind to a file should be a decision someone makes, not a property the file
 * quietly acquires.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extensions the scrub is knowingly blind to. Every entry is a format grep
 * cannot read and a human has accepted cannot be scanned — not a convenience
 * list, and never a place to silence a source file.
 */
const UNSCANNABLE_EXTENSIONS = new Set([".png", ".wasm"]);

/** Tracked paths, NUL-delimited so a newline in a filename cannot split one. */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  return out.toString("utf8").split("\0").filter((f) => f !== "");
}

describe("the scrub check reaches every source file", () => {
  it("finds no NUL byte outside the formats it is knowingly blind to", () => {
    const unreachable = trackedFiles().filter((rel) => {
      if (UNSCANNABLE_EXTENSIONS.has(path.extname(rel))) return false;
      let content: Buffer;
      try {
        content = readFileSync(path.join(repoRoot, rel));
      } catch {
        return false; // tracked but absent from the worktree — nothing to scan here.
      }
      return content.includes(0);
    });

    expect(
      unreachable,
      "These tracked files contain a NUL byte, so `grep -I` skips them and the scrub " +
        "check cannot see their contents. Write the NUL as a \\u0000 escape, or add the " +
        "format to UNSCANNABLE_EXTENSIONS as a deliberate decision.",
    ).toEqual([]);
  });

  it("still greps with -I, which is why the rule above exists", () => {
    // The lock's premise. If `-I` ever goes, a NUL-bearing source file stops
    // being invisible and this whole test can be reconsidered — deliberately.
    const script = readFileSync(path.join(repoRoot, "scripts/check-scrub.sh"), "utf8");
    expect(script).toMatch(/grep -I/);
  });
});
