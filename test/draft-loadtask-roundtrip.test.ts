/**
 * The pair invariant the front door stands on: what `renderDraft` writes,
 * `loadTask` parses — including the scalars that break bare YAML, because a
 * star-leading glob starts with an alias indicator and a title legitimately
 * contains a colon. Either package could be edited out of agreement with the
 * other, so the lock lives here at the root.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDraft, type Draft } from "@fleet/intake";
import { loadTask } from "@fleet/runner/task";

const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-draft-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("renderDraft → loadTask", () => {
  it("round-trips the hostile scalars", () => {
    const draft: Draft = {
      id: "tighten-retry-loop",
      title: "retry loop: cap the backoff *once*",
      target: "demo-ts-service",
      scope: ["**/*.ts", "src/retry/*.ts"],
      why: 'stop the "thundering herd: part two" pages',
      body: "Cap the backoff.\n\nNO_CHANGES_NEEDED applies if already capped.",
    };
    const file = path.join(dir, "draft.md");
    writeFileSync(file, renderDraft(draft));

    const task = loadTask(file);
    expect(task.id).toBe(draft.id);
    expect(task.title).toBe(draft.title);
    expect(task.targets).toEqual(["demo-ts-service"]);
    expect(task.scope).toEqual(draft.scope);
    expect(task.why).toBe(draft.why);
    expect(task.risk).toBe("low");
    // The two refusals, visible in the parsed shape: no gates, no amendment.
    expect(task.gates).toBeUndefined();
    expect(task.amends).toBeUndefined();
    expect(task.body).toContain("Cap the backoff.");
  });
});
