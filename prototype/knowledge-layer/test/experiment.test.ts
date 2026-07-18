import { describe, expect, it } from "vitest";
import { buildQuestionPrompt, type Question } from "../src/experiment.js";
import { QUESTIONS } from "../src/questions.js";

const question: Question = { id: "q", questionClass: "placement", text: "Where does muting land?" };

describe("buildQuestionPrompt", () => {
  it("gives both arms the same question and the same answer requirements", () => {
    const cold = buildQuestionPrompt("cold", question, "ARTIFACT BODY");
    const primed = buildQuestionPrompt("primed", question, "ARTIFACT BODY");

    for (const prompt of [cold, primed]) {
      expect(prompt).toContain("Where does muting land?");
      expect(prompt).toContain("at most 60 lines");
      expect(prompt).toContain("Everything you name as existing must actually exist");
    }
  });

  it("withholds the artifact from the cold arm", () => {
    expect(buildQuestionPrompt("cold", question, "ARTIFACT BODY")).not.toContain("ARTIFACT BODY");
  });

  it("hands the primed arm the artifact", () => {
    const primed = buildQuestionPrompt("primed", question, "ARTIFACT BODY");

    expect(primed).toContain("ARTIFACT BODY");
    expect(primed).toContain("---- KNOWLEDGE ARTIFACT ----");
  });

  it("gives neither arm an instruction about how much to explore", () => {
    const cold = buildQuestionPrompt("cold", question, "ARTIFACT BODY");
    const primed = buildQuestionPrompt("primed", question, "ARTIFACT BODY");

    // An asymmetric frugality hint would measure the instruction, not the artifact.
    for (const prompt of [cold, primed]) {
      expect(prompt).toContain("Open whatever files you need to answer well.");
      expect(prompt).not.toMatch(/Rely on the artifact|Explore as much as you need/);
    }
  });
});

describe("QUESTIONS", () => {
  it("covers each #52 must-handle question class exactly once", () => {
    expect(QUESTIONS.map((q) => q.questionClass).sort()).toEqual(["placement", "story-brief", "wiring"]);
  });
});
