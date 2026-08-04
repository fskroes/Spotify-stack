/**
 * The gate-input convention and the amendment that licenses one (ADR-0014,
 * ADR-0020). Pure path reasoning — no workspace, no git.
 */
import { describe, expect, it } from "vitest";
import { decideGateInputs, gateInputNote, isGateInput, noGateInputs } from "../src/gate-inputs.js";

describe("the gate-input convention", () => {
  // Source 1: what `detect()` reads to decide a check exists. These are the
  // files that decide *whether* a gate runs, so an unamended edit to one moves
  // the scoreboard by changing the question rather than the answer.
  it("covers the files detection reads", () => {
    for (const file of [
      "package.json",
      "mobile/package.json",
      "mobile/package-lock.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "Package.swift",
      "project.yml",
      "App.xcodeproj/project.pbxproj",
    ]) {
      expect(isGateInput(file), file).toBe(true);
    }
  });

  // Source 2: one universal convention, not a per-language list. The naming
  // convention, the directory conventions, and the fixture and helper shapes a
  // suite loads without importing.
  it("covers the test and fixture convention, at any depth", () => {
    for (const file of [
      "test/http.test.ts",
      "src/userService.spec.js",
      "packages/api/tests/e2e.py",
      "spec/parser_spec.rb",
      "Tests/AppTests/ParserTests.swift",
      "AppTests/ParserTests.swift",
      "src/__tests__/reducer.ts",
      "src/__mocks__/fetch.ts",
      "src/__fixtures__/user.json",
      "fixtures/payload.json",
      "tests/conftest.py",
    ]) {
      expect(isGateInput(file), file).toBe(true);
    }
  });

  // The set is partial by construction, and being wrong this way is free: a
  // gate input the convention misses is carried, which is what every run did
  // before ADR-0014 was built. Lint and runner configuration is the known,
  // recorded example (ADR-0020) — it is neither read by detection nor
  // test-shaped, and an override for it would be a separate justified change.
  it("does not claim ordinary source, or the config the convention omits", () => {
    for (const file of ["src/userService.ts", "README.md", "eslint.config.js", "vitest.config.ts"]) {
      expect(isGateInput(file), file).toBe(false);
    }
  });
});

/** The base commit's file list, as `decideGateInputs` asks about it. */
const base =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

/** A base that has every path the diff names — the "everything is an edit" case. */
const everything = () => true;

describe("decideGateInputs", () => {
  it("holds a gate input the task did not amend, and carries the rest of the diff", () => {
    const decision = decideGateInputs(["src/userService.ts", "test/http.test.ts"], {
      inBase: everything,
    });

    expect(decision.held).toEqual(["test/http.test.ts"]);
    expect(decision.carried).toEqual([]);
    expect(decision.introduced).toEqual([]);
    // The ordinary source file is not the tree's business: it is carried by
    // virtue of not being held, and nothing here has to say so.
    expect(decision.held).not.toContain("src/userService.ts");
    // Source rode along, so the tree is not the base.
    expect(decision.treeIsBase).toBe(false);
  });

  it("carries an amended gate input, with the reason attached", () => {
    const decision = decideGateInputs(["src/http.ts", "test/http.test.ts"], {
      inBase: everything,
      amends: [{ glob: "test/**", reason: "the asserted status code was wrong" }],
    });

    expect(decision.held).toEqual([]);
    expect(decision.carried).toEqual([
      { glob: "test/**", reason: "the asserted status code was wrong", files: ["test/http.test.ts"] },
    ]);
  });

  // A licence is a licence for what it names, and nothing else. This is the
  // property that makes `amends:` legible to a reader: one glob, one reason,
  // and every file outside it still held.
  it("licenses only the paths the glob names", () => {
    const decision = decideGateInputs(["test/http.test.ts", "test/userService.test.ts", "package.json"], {
      inBase: everything,
      amends: [{ glob: "test/http.test.ts", reason: "this one assertion was off by one" }],
    });

    expect(decision.held).toEqual(["test/userService.test.ts", "package.json"]);
    expect(decision.carried[0].files).toEqual(["test/http.test.ts"]);
  });

  // Declaration order decides, so a task reads top to bottom the way it was
  // written — and the reason a reader sees is the one whose glob they matched.
  it("attributes a doubly-matched file to the first amendment that names it", () => {
    const decision = decideGateInputs(["test/http.test.ts"], {
      inBase: everything,
      amends: [
        { glob: "test/http.test.ts", reason: "specific" },
        { glob: "test/**", reason: "general" },
      ],
    });

    expect(decision.carried).toEqual([
      { glob: "test/http.test.ts", reason: "specific", files: ["test/http.test.ts"] },
    ]);
  });

  // An amendment that licensed nothing is not a fact about the run. Recording
  // it would put a licence on the ledger and in the PR header for a diff that
  // never used one, which is the opposite of loud — it is noise that teaches a
  // reader to skip the affordance.
  it("reports nothing when the diff touched no gate input", () => {
    const decision = decideGateInputs(["src/userService.ts"], {
      inBase: everything,
      amends: [{ glob: "test/**", reason: "declared, never exercised" }],
    });

    expect(noGateInputs(decision)).toBe(true);
    expect(noGateInputs(undefined)).toBe(true);
  });

  // ADR-0021, and the whole of it: the hold exists to stop the agent weakening
  // what judges it, and a file the base does not have cannot have been weakened.
  // No licence is required to add one, because there is nothing to license.
  it("carries a gate input the base does not have, with no amendment", () => {
    const decision = decideGateInputs(["src/args.js", "tests/args.test.js"], {
      inBase: base("src/args.js"),
    });

    expect(decision.introduced).toEqual(["tests/args.test.js"]);
    expect(decision.held).toEqual([]);
    expect(decision.carried).toEqual([]);
    // Reported, not silent: the new gate ran, and what it proves is only worth
    // what it asserts — which is a reading the judge and the reviewer make.
    expect(noGateInputs(decision)).toBe(false);
    expect(decision.treeIsBase).toBe(false);
  });

  // The one case that survives ADR-0021's deletion, and the reason the run may
  // not report `passed`: every path is held, so the tree is the base commit and
  // the checks observe nothing about the change.
  it("reports treeIsBase when every path in the diff is held", () => {
    const decision = decideGateInputs(["tests/args.test.js", "tests/http.test.js"], {
      inBase: everything,
    });

    expect(decision.held).toEqual(["tests/args.test.js", "tests/http.test.js"]);
    expect(decision.treeIsBase).toBe(true);
  });

  // A diff of only *new* test files is the common shape this ADR fixes, and it
  // is emphatically not the degenerate case: the files are in the tree, so the
  // tree is not the base and the run verifies normally.
  it("does not report treeIsBase when the whole diff is new gate inputs", () => {
    const decision = decideGateInputs(["tests/base-probe.test.js"], { inBase: base() });

    expect(decision.introduced).toEqual(["tests/base-probe.test.js"]);
    expect(decision.treeIsBase).toBe(false);
  });

  // Both sides of a rename reach here (`stagedPaths --no-renames`). The source
  // is in the base and is restored, so a suite renamed away still runs; the
  // destination is a gate this diff introduced and runs beside it.
  it("holds the source of a renamed suite and carries its destination", () => {
    const decision = decideGateInputs(["tests/old.test.js", "tests/new.test.js"], {
      inBase: base("tests/old.test.js"),
    });

    expect(decision.held).toEqual(["tests/old.test.js"]);
    expect(decision.introduced).toEqual(["tests/new.test.js"]);
    expect(decision.treeIsBase).toBe(false);
  });
});

describe("gateInputNote", () => {
  // The judge's whole view of verification is this text, so every half has to
  // be in it: a hold it cannot see is a hold it cannot weigh, and a carried
  // gate input without its licence looks exactly like the tampering the licence
  // exists to distinguish it from.
  it("names the held files, the amended globs, and the reasons", () => {
    const note = gateInputNote(
      decideGateInputs(["test/http.test.ts", "test/userService.test.ts"], {
        inBase: everything,
        amends: [{ glob: "test/http.test.ts", reason: "the asserted status code was wrong" }],
      }),
    );

    expect(note).toContain("CARRIED UNDER AN AMENDMENT");
    expect(note).toContain("the asserted status code was wrong");
    expect(note).toContain("HELD AT THE BASE");
    expect(note).toContain("test/userService.test.ts");
    expect(note).toContain("not part of what proves it");
  });

  // The residual risk ADR-0021 hands to the judge by name: a new gate ran, and
  // a new gate that asserts nothing passes just as well as one that does. No
  // path rule reaches that — it is *playing to the scoreboard*, not moving it.
  it("names the gate inputs the change adds, and asks what they assert", () => {
    const note = gateInputNote(
      decideGateInputs(["tests/args.test.js"], { inBase: base() }),
    );

    expect(note).toContain("GATE INPUTS THIS CHANGE ADDS");
    expect(note).toContain("tests/args.test.js");
    expect(note).toContain("Judge what they assert");
    expect(note).not.toContain("HELD AT THE BASE");
  });

  // The degenerate case says so in the judge's own text, not only in the state
  // field: a green above this note was earned on a tree with none of the change.
  it("says outright that nothing was verified when the tree is the base", () => {
    const note = gateInputNote(
      decideGateInputs(["tests/args.test.js"], { inBase: everything }),
    );

    expect(note).toContain("NOTHING OF THIS CHANGE WAS VERIFIED");
    expect(note).toContain("INCONCLUSIVE");
  });
});
