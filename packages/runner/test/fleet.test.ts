import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// resolveOwner shells out to `gh` only on the fallback path — mock it so the test
// never touches a real gh, and so we can assert it's NOT called when env is set.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import { loadFleet, resolveOwner } from "../src/fleet.js";
import { defaultJudgeMode } from "../src/run.js";

const savedOwner = process.env.GH_OWNER;
const savedCI = process.env.GITHUB_ACTIONS;

afterEach(() => {
  if (savedOwner === undefined) delete process.env.GH_OWNER;
  else process.env.GH_OWNER = savedOwner;
  if (savedCI === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = savedCI;
  execFileSyncMock.mockReset();
});

describe("resolveOwner", () => {
  it("returns GH_OWNER from the environment without calling gh", () => {
    process.env.GH_OWNER = "env-owner";
    expect(resolveOwner()).toBe("env-owner");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("derives the owner from `gh api user` when unset and caches it into the env", () => {
    delete process.env.GH_OWNER;
    execFileSyncMock.mockReturnValue("octocat\n");
    expect(resolveOwner()).toBe("octocat");
    expect(process.env.GH_OWNER).toBe("octocat"); // cached back so all consumers agree
    expect(execFileSyncMock).toHaveBeenCalledWith("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf8",
    });
  });

  it("returns an empty string when gh is unavailable", () => {
    delete process.env.GH_OWNER;
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    expect(resolveOwner()).toBe("");
    expect(process.env.GH_OWNER).toBeUndefined();
  });
});

describe("loadFleet overlay (fleet/repos.local.yaml)", () => {
  const BASE =
    "repos:\n  - name: demo\n    url: https://github.com/${GH_OWNER}/demo\n    language: typescript\n    default_branch: main\n";
  function control(base: string, overlay?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    mkdirSync(join(dir, "fleet"));
    writeFileSync(join(dir, "fleet", "repos.yaml"), base);
    if (overlay != null) writeFileSync(join(dir, "fleet", "repos.local.yaml"), overlay);
    return dir;
  }

  it("returns only the public repos when no overlay is present", () => {
    process.env.GH_OWNER = "acme";
    const repos = loadFleet(control(BASE));
    expect(repos.map((r) => r.name)).toEqual(["demo"]);
    expect(repos[0].url).toBe("https://github.com/acme/demo"); // ${GH_OWNER} expanded
  });

  it("merges private targets from repos.local.yaml", () => {
    process.env.GH_OWNER = "acme";
    const overlay =
      "repos:\n  - name: secret\n    url: https://github.com/${GH_OWNER}/secret\n    language: javascript\n    default_branch: main\n";
    const repos = loadFleet(control(BASE, overlay));
    expect(repos.map((r) => r.name).sort()).toEqual(["demo", "secret"]);
  });

  it("lets an overlay entry override a public one by name", () => {
    process.env.GH_OWNER = "acme";
    const overlay =
      "repos:\n  - name: demo\n    url: https://github.com/${GH_OWNER}/demo\n    language: javascript\n    default_branch: dev\n";
    const repos = loadFleet(control(BASE, overlay));
    expect(repos).toHaveLength(1);
    expect(repos[0].default_branch).toBe("dev");
    expect(repos[0].language).toBe("javascript");
  });
});

describe("defaultJudgeMode", () => {
  it("defaults to the subscription cli judge locally", () => {
    delete process.env.GITHUB_ACTIONS;
    expect(defaultJudgeMode()).toBe("cli");
  });

  it("defaults to the SDK claude judge in CI", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(defaultJudgeMode()).toBe("claude");
  });
});
