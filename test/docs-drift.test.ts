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

import { REVIEW_ARTIFACTS } from "../packages/runner/src/artifacts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** Backticked `code spans` inside a chunk of markdown. */
function codeSpans(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** The paragraph beginning with `prefix`, or a loud failure naming the file. */
function paragraphStartingWith(markdown: string, prefix: string, file: string): string {
  const start = markdown.indexOf(prefix);
  if (start === -1) {
    throw new Error(
      `drift-lock anchor not found in ${file}: no paragraph starts with "${prefix}". ` +
        `The prose was reworded — re-point this lock at the new wording.`,
    );
  }
  const end = markdown.indexOf("\n\n", start);
  return markdown.slice(start, end === -1 ? undefined : end);
}

/** The first fenced code block after `heading`. */
function fenceAfterHeading(markdown: string, heading: string, file: string): string {
  const at = markdown.indexOf(heading);
  if (at === -1) throw new Error(`drift-lock anchor not found in ${file}: no "${heading}" heading.`);
  const open = markdown.indexOf("```", at);
  const close = markdown.indexOf("```", open + 3);
  if (open === -1 || close === -1) {
    throw new Error(`drift-lock anchor not found in ${file}: no fenced block under "${heading}".`);
  }
  return markdown.slice(open + 3, close);
}

describe("README artifact allowlist", () => {
  it("names exactly the REVIEW_ARTIFACTS the operator API will serve", () => {
    const paragraph = paragraphStartingWith(read("README.md"), "Artifact reads are limited to", "README.md");
    // `artifacts/` also appears in the sentence as a path; only filenames carry a dot.
    const documented = codeSpans(paragraph).filter((s) => s.includes("."));

    expect(new Set(documented)).toEqual(new Set(REVIEW_ARTIFACTS.keys()));
  });
});

describe("README layout block", () => {
  it("lists every workspace under packages/ and apps/", () => {
    const fence = fenceAfterHeading(read("README.md"), "## Layout", "README.md");
    const workspaces = ["packages", "apps"].flatMap((group) =>
      readdirSync(path.join(repoRoot, group), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${group}/${e.name}`),
    );

    const missing = workspaces.filter((w) => !fence.includes(w));
    expect(missing, `README "## Layout" does not mention: ${missing.join(", ")}`).toEqual([]);
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
