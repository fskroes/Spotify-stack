import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildIndex, buildRepoMap, renderMap } from "../src/map.js";
import type { RepoMap } from "../src/types.js";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kl-map-"));
  mkdirSync(join(dir, "Sources"), { recursive: true });

  writeFileSync(
    join(dir, "Sources/Store.swift"),
    `final class Store {
    func load(id: String) -> Message? { return nil }
}
struct Message { let id: String }
`,
  );
  writeFileSync(
    join(dir, "Sources/InboxView.swift"),
    `import SwiftUI
struct InboxView: View {
    func body() { Store().load(id: "1") }
}
`,
  );
  writeFileSync(join(dir, "README.md"), "# fixture\n");

  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return dir;
}

describe("buildRepoMap", () => {
  let dir: string;
  let map: RepoMap;

  beforeAll(() => {
    dir = fixtureRepo();
    map = buildRepoMap(dir, { budgetTokens: 1000 });
  });

  it("stamps the map with the repo's current HEAD sha", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

    expect(map.sha).toBe(head);
  });

  it("includes only files a grammar can parse", () => {
    expect(map.files.map((f) => f.file).sort()).toEqual(["Sources/InboxView.swift", "Sources/Store.swift"]);
  });

  it("orders files by rank, depended-on code first", () => {
    expect(map.files[0].file).toBe("Sources/Store.swift");
  });

  it("stays inside the token budget and reports what it spent", () => {
    const tight = buildRepoMap(dir, { budgetTokens: 12 });

    expect(tight.usedTokens).toBeLessThanOrEqual(12);
    expect(tight.filesOmitted).toBeGreaterThan(0);
  });

  it("renders paths, kinds and signatures a reader can act on", () => {
    const rendered = renderMap(map);

    expect(rendered).toContain("Sources/Store.swift");
    expect(rendered).toContain("func load(id: String) -> Message?");
    expect(rendered).toContain("class Store");
  });

  it("builds an index of every file and symbol for the grounding check", () => {
    const index = buildIndex(dir);

    expect(index.files.has("README.md")).toBe(true);
    expect(index.symbols.has("Store")).toBe(true);
    expect(index.symbols.has("load")).toBe(true);
    expect(index.sha).toBe(map.sha);
  });
});
