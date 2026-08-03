/**
 * The PR body cites the task file so a co-signer can check the claim against
 * what was asked for. A citation that cannot resolve is worse than no citation:
 * it looks checkable. `tasks/private/` is git-ignored, so a private task's path
 * sits inside the control repo and its blob URL 404s forever — measured on the
 * 2026-08-03 run against a real target, whose PR linked a page that has never
 * existed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { taskFileUrl } from "../src/run.js";

const WEB = "https://github.com/owner/control";
let controlRepo: string;

beforeAll(() => {
  controlRepo = mkdtempSync(path.join(os.tmpdir(), "fleet-tasks-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: controlRepo, encoding: "utf8" });

  mkdirSync(path.join(controlRepo, "tasks", "private"), { recursive: true });
  writeFileSync(path.join(controlRepo, "tasks", "public.md"), "---\nid: pub\n---\n");
  writeFileSync(path.join(controlRepo, "tasks", "private", "secret.md"), "---\nid: sec\n---\n");
  writeFileSync(path.join(controlRepo, ".gitignore"), "tasks/private/\n");

  git(["init", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "tasks", "--quiet"]);
});

describe("taskFileUrl", () => {
  it("links a task the control repo tracks", () => {
    const url = taskFileUrl(controlRepo, path.join(controlRepo, "tasks/public.md"), WEB);
    expect(url).toBe(`${WEB}/blob/main/tasks/public.md`);
  });

  it("omits the link for a git-ignored task, which would 404 forever", () => {
    const onDisk = path.join(controlRepo, "tasks/private/secret.md");
    expect(taskFileUrl(controlRepo, onDisk, WEB)).toBeUndefined();
  });

  it("omits the link for a task file outside the control repo", () => {
    const elsewhere = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-away-")), "t.md");
    writeFileSync(elsewhere, "---\nid: away\n---\n");
    expect(taskFileUrl(controlRepo, elsewhere, WEB)).toBeUndefined();
  });

  it("omits the link when the control repo has no web url", () => {
    expect(taskFileUrl(controlRepo, path.join(controlRepo, "tasks/public.md"), undefined)).toBeUndefined();
  });
});
