/**
 * Documentation drift locks.
 *
 * Prose that *explains* code is deliberately absent from this repo's docs (see
 * `docs/README.md`). What remains, and what does drift, is a small number of
 * hand-copied **enumerations** — lists a reader genuinely wants in prose while
 * the code owns the real thing. Three of them went stale before this test
 * existed: the artifact allowlist lost `model-usage.json`, the layout block
 * lost four workspaces, and the gate vocabulary never learned about nested
 * workspace suffixes.
 *
 * Each lock below pins one such list to its source constant, so drift is a red
 * build instead of something a reader discovers a year later. This is the same
 * choice `RUN_FACTS` makes with `satisfies` and `check-scrub.sh` makes with a
 * hook: a mechanical gate rather than remembering.
 *
 * These tests anchor on prose. If a rewrite moves an anchor the test fails
 * loudly with "anchor not found" — that is the intended failure, not a false
 * positive: it means a human must re-point the lock at the new wording.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** The `## `-delimited section under `heading`, up to the next one. */
function sectionUnderHeading(markdown: string, heading: string, file: string): string {
  const at = markdown.indexOf(heading);
  if (at === -1) {
    throw new Error(
      `drift-lock anchor not found in ${file}: no "${heading}" heading. ` +
        `The prose was reworded — re-point this lock at the new wording.`,
    );
  }
  const end = markdown.indexOf("\n## ", at + heading.length);
  return markdown.slice(at, end === -1 ? undefined : end);
}

/**
 * The artifact allowlist lock is **deleted, not re-pointed** (2026-08-01).
 *
 * It pinned a hand-copied filename list in README.md to `REVIEW_ARTIFACTS`. The
 * README no longer carries that list: it became a landing page, and the two
 * places that still describe the served set — ADR-0005 and ADR-0007 — name the
 * constant instead of restating its members. A reference to a constant cannot
 * drift from it, so there is no longer a copy to lock, and a lock with no
 * subject is worse than none: it fails on wording and teaches people that a red
 * drift test is noise.
 *
 * If a list of those filenames is ever written into prose again, bring this back
 * — that is the moment it starts being able to lie.
 */

describe("README decision count", () => {
  /**
   * The landing page states how many ADRs exist, twice — a badge and a link.
   * Both were written when there were twelve and neither moved when 0013–0015
   * landed, which is the same failure the locks above exist for: a number is a
   * one-token enumeration, and `docs/adr/` is the thing that actually knows it.
   */
  it("agrees with the number of ADRs on disk", () => {
    const adrs = readdirSync(path.join(repoRoot, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f));
    const readme = read("README.md");
    const claims = [...readme.matchAll(/(\d+)[ _](?:Decisions|decisions)/g)].map((m) => Number(m[1]));

    expect(
      claims.length,
      "anchor not found in README.md: nothing reads as a decision count. " +
        "The prose was reworded — re-point this lock at the new wording.",
    ).toBeGreaterThan(0);
    expect(new Set(claims)).toEqual(new Set([adrs.length]));
  });
});

describe("docs map layout table", () => {
  /**
   * The workspace enumeration moved with the README rewrite: the landing page
   * dropped its `## Layout` fence, and `docs/README.md`'s "Where the code lives"
   * table is now the only prose that claims to list every unit. Same list, same
   * failure mode, so the lock follows it rather than dying with the fence.
   */
  it("lists every workspace under packages/ and apps/", () => {
    const section = sectionUnderHeading(
      read("docs/README.md"),
      "## Where the code lives, and what each part owns",
      "docs/README.md",
    );
    const workspaces = ["packages", "apps"].flatMap((group) =>
      readdirSync(path.join(repoRoot, group), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${group}/${e.name}`),
    );

    const missing = workspaces.filter((w) => !section.includes(w));
    expect(missing, `docs/README.md's layout table does not mention: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("docs reading list", () => {
  /**
   * Every evidence doc under `docs/` (ADRs excepted — `adr/README.md` indexes
   * those) is either reachable from the map or explicitly opted out.
   *
   * The opt-out is the point. A lock demanding that *every* file appear would
   * turn a curated reading list into a directory listing and remove the
   * editorial power a thin nav layer depends on. Leaving a doc unlisted stays a
   * decision you can make — it just has to be a recorded one, the same shape
   * `RUN_FACTS` uses: new members are not banned, they are forced to be decided
   * about.
   */
  const NAV_SKIP = "<!-- nav: skip -->";

  const evidenceDocs = (dir: string): string[] =>
    readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return rel.endsWith("/adr") ? [] : evidenceDocs(rel);
      return entry.name.endsWith(".md") && rel !== "docs/README.md" ? [rel] : [];
    });

  it("links every doc under docs/ that has not opted out", () => {
    const map = read("docs/README.md");
    const unreachable = evidenceDocs("docs").filter(
      // Links in docs/README.md are relative to docs/ itself.
      (rel) => !map.includes(rel.slice("docs/".length)) && !read(rel).includes(NAV_SKIP),
    );

    expect(
      unreachable,
      `unreachable from docs/README.md, and not carrying "${NAV_SKIP}": ${unreachable.join(", ")}`,
    ).toEqual([]);
  });
});

describe("task template gate vocabulary", () => {
  /**
   * The check names verification can emit, read out of the detector itself.
   * Names are template literals carrying a nested-workspace suffix
   * (`test${suffix}` → `test:packages/api` in a nested workspace, `test` at the
   * root); the base name is what the template documents.
   */
  const detectedCheckNames = (): string[] => {
    const src = read("packages/mcp-verify/src/verify.js");
    const names = [...src.matchAll(/name:\s*[`"]([a-z-]+)(\$\{suffix\})?[`"]/g)].map((m) => m[1]);
    expect(names.length, "no check names parsed out of verify.js — the detector was restructured").toBeGreaterThan(0);
    return [...new Set(names)];
  };

  it("documents every check name a task may mandate as a gate", () => {
    const template = read("tasks/TEMPLATE.md");
    const missing = detectedCheckNames().filter((name) => !template.includes(name));

    expect(missing, `tasks/TEMPLATE.md does not document gate name(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("explains that a nested workspace's checks are suffixed", () => {
    // Matching is exact (`findUnmetGates` uses set membership), so a task
    // mandating a nested check must name it in full. A template that documents
    // only base names silently hides that.
    const template = read("tasks/TEMPLATE.md");
    expect(template).toMatch(/suffix/i);
    expect(template).toMatch(/test:[\w./-]+/);
  });
});
