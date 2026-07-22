import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndex, buildRepoMap, renderMap } from "../src/index.js";
import type { RepoIndex, RepoMap } from "../src/index.js";

const demoRepos = fileURLToPath(new URL("../../../demo-repos/", import.meta.url));
const repo = (name: string) => path.join(demoRepos, name);

describe("@fleet/knowledge public API", () => {
  it("indexes tracked TypeScript definitions from the demo target", async () => {
    const index: RepoIndex = await buildIndex(repo("demo-ts-service"));

    expect(index.files).toContain("src/userService.ts");
    expect(index.symbols.map((symbol) => symbol.name)).toContain("User");
    expect(index.symbols.map((symbol) => symbol.name)).toContain("getUser");
  });

  it("indexes tracked Swift definitions from the demo target", async () => {
    const index: RepoIndex = await buildIndex(repo("demo-swift-package"));

    expect(index.files).toContain("Sources/DemoKit/Greeting.swift");
    expect(index.symbols.map((symbol) => symbol.name)).toContain("Greeting");
    expect(index.symbols.map((symbol) => symbol.name)).toContain("banner");
  });

  it("builds a byte-stable rendered map with default and tight budgets", async () => {
    const first: RepoMap = await buildRepoMap(repo("demo-ts-service"));
    const second = await buildRepoMap(repo("demo-ts-service"));
    const tight = await buildRepoMap(repo("demo-ts-service"), { budgetTokens: 1 });

    expect(first).toEqual(second);
    expect(renderMap(first)).toBe(renderMap(second));
    expect(first.budgetTokens).toBe(15_000);
    expect(first.files.map((file) => file.file)).toContain("src/userService.ts");
    expect(tight.usedTokens).toBeLessThanOrEqual(1);
    expect(tight.filesOmitted).toBeGreaterThan(0);
  });
});
