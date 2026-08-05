/**
 * The drafter: an intent plus a target's structure in, a task file out.
 *
 * It writes no `gates:`, ever. A machine-invented gate name and a typo are
 * indistinguishable on the wire — both report unmet and land the run
 * `inconclusive` (ADR-0004) — so a drafted gate would spend a run to say
 * nothing. Mandating a check stays an act of authorship.
 *
 * It refuses rather than guess a `scope:`. An absent scope is not a wide cage,
 * it is no cage: the runner's scope gate has nothing to compare a diff against,
 * and the only remaining limit is the judge's opinion. A refusal costs one
 * message; a guessed scope costs the property the gate exists for.
 *
 * This module holds no I/O. It builds a prompt, parses a reply, and renders
 * markdown — so every rule above is testable without a model.
 */

/** A drafted task, in the shape `loadTask()` already parses. */
export interface Draft {
  id: string;
  title: string;
  target: string;
  /** Path globs the diff may touch. Never empty — an empty scope is a refusal. */
  scope: string[];
  why: string;
  /** The task prompt the agent reads. Frontmatter is rendered separately. */
  body: string;
}

/** The drafter declining to produce a task, with the reason a human reads. */
export interface Refusal {
  refused: true;
  reason: string;
}

export type DraftResult = Draft | Refusal;

export function isRefusal(result: DraftResult): result is Refusal {
  return "refused" in result;
}

/**
 * The prompt. Grounded on the deterministic structural map, which every target
 * has for free, and on the compiled prose only when the target happens to carry
 * it — so the front door works on a cold target rather than putting a $0.79
 * compile in front of every draft.
 */
export function buildDraftPrompt(args: {
  target: string;
  renderedMap: string;
  prose: string | null;
  intent: string;
}): string {
  const { target, renderedMap, prose, intent } = args;
  return [
    `You are drafting a task file for the repository \`${target}\`. You are not writing code.`,
    "",
    "## What someone asked for",
    "",
    intent,
    "",
    ...(prose
      ? ["## Compiled understanding of this repository", "", prose.trim(), ""]
      : ["## No compiled prose for this target — work from the structure below alone.", ""]),
    "## Structural map",
    "",
    renderedMap.trimEnd(),
    "",
    "## What to produce",
    "",
    "Reply with a single JSON object and nothing else. Either a draft:",
    "",
    '{"id":"kebab-slug","title":"one line","scope":["glob",...],"why":"one sentence","body":"markdown"}',
    "",
    "or a refusal:",
    "",
    '{"refused":true,"reason":"one sentence naming what you could not determine"}',
    "",
    "### The rules that decide which",
    "",
    "- **`scope` is the cage.** It lists the path globs the change may touch, and the",
    "  runner mechanically kills any diff that falls outside them. Derive it from the",
    "  map above — the files this intent actually reaches. If you cannot tell which",
    "  files a change would touch, **refuse**. An absent or guessed scope is not a",
    "  wide cage; it is no cage at all, and a wrong one kills a correct change.",
    "- **Never propose gates, checks, or verifier names.** Not in `scope`, not in the",
    "  body. Mandating a check is the operator's signature, not yours.",
    "- **`body` is the task prompt the agent will read.** Describe the END STATE, not",
    "  steps. State the precondition under which the agent must do nothing, and end",
    "  that section with the sentinel `NO_CHANGES_NEEDED`. Include a concrete example",
    "  where one helps. Close with a Verification section telling the agent to call",
    "  the `verify` tool, and a Scope section forbidding unrelated changes.",
    "- **`why` is one sentence for the human who will co-sign**, in their words, not a",
    "  restatement of the title.",
    "- Keep it atomic. One change per task. If the intent needs two, draft the first",
    "  and say so in `why`.",
  ].join("\n");
}

/**
 * Parse the model's reply. Tolerant about what surrounds the JSON (a fenced
 * block, a stray sentence) and strict about what is inside it: a draft missing
 * a usable scope is read as a refusal rather than repaired, because repairing
 * it here would be the guess the drafter exists to avoid.
 */
export function parseDraftReply(reply: string, target: string): DraftResult {
  const json = extractJsonObject(reply);
  if (!json) return { refused: true, reason: "the drafter returned no JSON object" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { refused: true, reason: "the drafter returned malformed JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { refused: true, reason: "the drafter returned no object" };
  }

  const value = parsed as Record<string, unknown>;
  if (value.refused === true) {
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    return { refused: true, reason: reason || "the drafter refused without a reason" };
  }

  const scope = Array.isArray(value.scope)
    ? value.scope.filter((glob): glob is string => typeof glob === "string" && glob.trim() !== "")
    : [];
  if (scope.length === 0) {
    return { refused: true, reason: "the drafter proposed no scope, and a task without a cage is not a draft" };
  }

  const id = slugify(typeof value.id === "string" ? value.id : "");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  if (!id) return { refused: true, reason: "the drafter proposed no usable id" };
  if (!title) return { refused: true, reason: "the drafter proposed no title" };
  if (!body) return { refused: true, reason: "the drafter proposed no task body" };

  const why = typeof value.why === "string" && value.why.trim() ? value.why.trim() : title;
  return { id, title, target, scope: scope.map((glob) => glob.trim()), why, body };
}

/**
 * Render the draft as a task file. `risk: low` is fixed rather than drafted:
 * the drafter's whole licence is the case where a scope is derivable, and risk
 * above low is the operator's judgement about blast radius, which is exactly the
 * judgement no machine here has earned.
 *
 * No `gates:` key is emitted. Its absence is the refusal, not an omission.
 */
/**
 * The marker whose *removal* is the act of review. A two-valued log fills with
 * silence, and silence means either "the machine was right" or "nobody looked" —
 * so approval must cost a gesture. Deleting this comment is the cheapest gesture
 * that is still authorship: scope edited → `narrowed`; marker gone, scope kept →
 * `reviewed-unchanged`; both untouched → `unreviewed`, which is evidence of
 * nothing.
 */
export const REVIEW_MARKER = "<!-- fleet-draft: unreviewed" as const;

export function renderDraft(draft: Draft): string {
  // Every scalar is JSON-quoted: a glob like `**/*.ts` starts with `*`, which
  // bare YAML reads as an alias, and loadTask() would throw on the drafter's
  // own output.
  const q = JSON.stringify;
  return [
    "---",
    `id: ${q(draft.id)}`,
    `title: ${q(draft.title)}`,
    `targets: [${q(draft.target)}]`,
    `scope: [${draft.scope.map((glob) => q(glob)).join(", ")}]`,
    "risk: low",
    `why: ${q(draft.why)}`,
    "---",
    "",
    REVIEW_MARKER,
    "",
    "Drafted by `fleet draft`, not hand-authored. Two things it deliberately did",
    "not do: it proposed no `gates:`, and it would have refused rather than guess",
    "the `scope:` above. Narrow the scope if it is loose — that edit is the",
    "measurement. When the scope is right as drafted, DELETE THIS COMMENT: that",
    "deletion is what records `reviewed-unchanged`. Left in place, the run is",
    "recorded as `unreviewed`, which is evidence of nothing.",
    "-->",
    "",
    draft.body.trim(),
    "",
  ].join("\n");
}

/** The scope as the runner will read it back, for comparing a draft to its edit. */
export function scopeKey(scope: readonly string[]): string {
  return [...scope].map((glob) => glob.trim()).sort().join("\u0000");
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Pull the first balanced `{...}` out of a reply. Brace counting rather than a
 * regex because a task body legitimately contains braces, and a lazy match would
 * truncate the draft at the first one.
 */
function extractJsonObject(reply: string): string | null {
  const start = reply.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < reply.length; i++) {
    const ch = reply[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return reply.slice(start, i + 1);
    }
  }
  return null;
}
