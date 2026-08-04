import { describe, expect, it } from "vitest";
import {
  buildDraftPrompt,
  isRefusal,
  parseDraftReply,
  renderDraft,
  REVIEW_MARKER,
  type Draft,
} from "../src/index.js";

const target = "demo-ts-service";

describe("parseDraftReply", () => {
  it("reads a draft out of a reply with prose around the JSON", () => {
    const reply = [
      "Here is the draft:",
      "```json",
      JSON.stringify({
        id: "Fix The Thing!",
        title: "fix the thing",
        scope: ["src/**/*.ts", " test/helpers.ts "],
        why: "so it works",
        body: "Do the thing. `{ nested: { braces } }` stay intact.",
      }),
      "```",
    ].join("\n");
    const result = parseDraftReply(reply, target);
    expect(isRefusal(result)).toBe(false);
    const draft = result as Draft;
    expect(draft.id).toBe("fix-the-thing");
    expect(draft.scope).toEqual(["src/**/*.ts", "test/helpers.ts"]);
    expect(draft.body).toContain("{ nested: { braces } }");
  });

  it("passes a refusal through with its reason", () => {
    const result = parseDraftReply('{"refused":true,"reason":"cannot place the change"}', target);
    expect(result).toEqual({ refused: true, reason: "cannot place the change" });
  });

  it("reads a draft without a usable scope as a refusal, never repairing it", () => {
    for (const scope of [undefined, [], ["", "  "]]) {
      const result = parseDraftReply(
        JSON.stringify({ id: "x", title: "x", scope, why: "x", body: "x" }),
        target,
      );
      expect(isRefusal(result)).toBe(true);
    }
  });

  it("refuses on no JSON and on malformed JSON", () => {
    expect(isRefusal(parseDraftReply("no object here", target))).toBe(true);
    expect(isRefusal(parseDraftReply("{broken", target))).toBe(true);
  });
});

describe("buildDraftPrompt", () => {
  it("forbids gates and demands a refusal over a guessed scope", () => {
    const prompt = buildDraftPrompt({ target, renderedMap: "map", prose: null, intent: "do x" });
    expect(prompt).toContain("Never propose gates");
    expect(prompt).toContain("refuse");
    expect(prompt).toContain("No compiled prose");
  });
});

describe("renderDraft", () => {
  const draft: Draft = {
    id: "fix-the-thing",
    title: "fix: the thing",
    target,
    scope: ["**/*.ts"],
    why: "so it works",
    body: "Do the thing.",
  };

  it("carries the review marker whose deletion records reviewed-unchanged", () => {
    expect(renderDraft(draft)).toContain(REVIEW_MARKER);
  });

  it("never emits a gates key", () => {
    expect(renderDraft(draft)).not.toMatch(/^gates:/m);
  });
});
