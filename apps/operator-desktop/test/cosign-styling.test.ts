/**
 * The join between `cosignAffordance` and the stylesheet.
 *
 * `stance` is a domain word that is also spliced into a class list, so the two
 * files have a contract nothing else asserts: `main.ts` carries no test coverage
 * by design (#66), which leaves renaming a stance — or scoping its rule too
 * tightly — a silent way to drop the warning while every other test stays green.
 * A warning that fails to render is the same false green this map exists to
 * remove, so it gets a guard even though the guard has to read CSS as text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cosignAffordance } from "../src/verify-view";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const opts = { prNumber: "12", retry: false };

describe("the unproven merge button's styling", () => {
  it("has a rule for the stance the affordance actually emits", () => {
    // Read from the function rather than hardcoded, so renaming the stance
    // fails here instead of silently rendering an unstyled button.
    const { stance } = cosignAffordance({ verifyState: "inconclusive" }, opts);
    expect(css).toContain(`button.cosign-merge.${stance}`);
  });

  it("reaches the confirm dialog, not only the decision rail", () => {
    // The bug this exists to catch: scoping the rule under `.decision-spot-actions`
    // styles the button that *opens* the dialog and leaves the one that actually
    // signs looking plain — warning the wrong button of the two.
    const scoped = /\.decision-spot-actions[^{]*\.cosign-merge\.unproven[^{]*\{/;
    expect(css).not.toMatch(scoped);
    expect(css).toMatch(/^button\.cosign-merge\.unproven\s*\{/m);
  });

  it("keeps a proven run on the plain primary button", () => {
    // The warn tone must stay exceptional: if "proven" ever grows its own rule,
    // the two stances stop being visually distinguishable at a glance.
    const { stance } = cosignAffordance({ verifyState: "passed" }, opts);
    expect(stance).toBe("proven");
    expect(css).not.toContain(`button.cosign-merge.${stance}`);
  });
});
