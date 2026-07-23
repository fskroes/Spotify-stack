import { describe, expect, it } from "vitest";
import {
  checkGrounding,
  compileKnowledgeArtifact,
  parseKnowledgeArtifact,
  validateKnowledgeProse,
  type ParsedSymbol,
  type RepoIndex,
} from "../src/index.js";

// A compact structural index standing in for the mail-sync pilot repository: a
// native macOS menu-bar app whose knowledge artifact overclaimed behavior from
// names alone. Every domain file and symbol the corrected artifact references
// resolves here, so the grounding ratio is high — the point of the regression is
// that a high structural ratio still must not read as proof of behavioral prose.
const files = [
  "MailSync/CONTEXT.md",
  "MailSync/Services/SyncCycle.swift",
  "MailSync/Services/SyncService.swift",
  "MailSync/Services/GraphService.swift",
  "MailSync/Services/RequestGate.swift",
  "MailSync/Services/HTTPClient.swift",
  "MailSync/Services/ClaudeService.swift",
  "MailSync/Services/ClaudeTransport.swift",
  "MailSync/Services/AuthService.swift",
  "MailSync/App/FirstRunCoordinator.swift",
  "MailSync/Storage/ModelContainer+Setup.swift",
  "docs/ARCHITECTURE.md",
  "scripts/ai-contract-check/main.swift",
];

const symbol = (name: string, file: string): ParsedSymbol => ({ name, kind: "class", file, line: 1, signature: `class ${name}` });

const symbols: ParsedSymbol[] = [
  symbol("SyncCycle", "MailSync/Services/SyncCycle.swift"),
  symbol("Dependencies", "MailSync/Services/SyncCycle.swift"),
  symbol("SyncService", "MailSync/Services/SyncService.swift"),
  symbol("GraphService", "MailSync/Services/GraphService.swift"),
  symbol("RequestGate", "MailSync/Services/RequestGate.swift"),
  symbol("HTTPClient", "MailSync/Services/HTTPClient.swift"),
  symbol("ClaudeService", "MailSync/Services/ClaudeService.swift"),
  symbol("ClaudeTransport", "MailSync/Services/ClaudeTransport.swift"),
  symbol("ClaudeAPITransport", "MailSync/Services/ClaudeTransport.swift"),
  symbol("ClaudeCLITransport", "MailSync/Services/ClaudeTransport.swift"),
  symbol("ClaudeTransportFactory", "MailSync/Services/ClaudeTransport.swift"),
  symbol("useClaudeCLI", "MailSync/Services/ClaudeTransport.swift"),
  symbol("AuthService", "MailSync/Services/AuthService.swift"),
  symbol("FirstRunCoordinator", "MailSync/App/FirstRunCoordinator.swift"),
  symbol("SchemaV1", "MailSync/Storage/ModelContainer+Setup.swift"),
  symbol("SchemaV7", "MailSync/Storage/ModelContainer+Setup.swift"),
  symbol("MailSyncMigrationPlan", "MailSync/Storage/ModelContainer+Setup.swift"),
];

const pilotIndex: RepoIndex = {
  repo: "mail-pilot",
  sha: "c3589a23b07aa1ff14099f5ea8304651dda66ea1",
  dirty: false,
  files,
  parsedFiles: [],
  symbols,
  filesSkipped: [],
};

// The corrected artifact the hardened contract should accept: the pilot's
// overclaims fixed, the documentation conflict surfaced, and Unknowns kept to
// product/engineering decisions rather than map mechanics.
const correctedProse = `## Product

MailSync is a native macOS menu-bar app that watches a Microsoft mailbox for implied commitments and hands them to Calendar and Reminders. Its ubiquitous language (sync cycle, surfacing, commitment, hand-off) is defined in \`MailSync/CONTEXT.md\`.

## Architecture

The engine lives under \`MailSync/Services/\`. \`SyncCycle\` orchestrates one run while \`SyncService\` wires it to a timer and live dependencies; mailbox access goes through \`GraphService\`, AI through \`ClaudeService\`, and auth through \`AuthService\`. Persistence is versioned SwiftData configured in \`MailSync/Storage/ModelContainer+Setup.swift\`.

## Key seams

- \`Dependencies\` on \`SyncCycle\` is the central injection point: \`SyncService\` wires production, tests wire fakes.
- \`ClaudeTransport\` selects \`ClaudeAPITransport\` or \`ClaudeCLITransport\` through \`ClaudeTransportFactory\`, per the \`useClaudeCLI\` setting.

## Principal data flows

\`SyncService\` builds live \`Dependencies\` and drives \`SyncCycle\`. \`SyncCycle\` is dependency-injected orchestration that performs I/O through those injected dependencies rather than in isolation: it reads the mailbox via \`GraphService\`, may call \`ClaudeService\`, and writes results back. Onboarding can complete without AI — \`FirstRunCoordinator\` exposes an optional no-AI path, so a first run that skips Claude still reaches the inbox.

## Conventions

- Concurrency: \`RequestGate\` bounds concurrent Microsoft Graph requests specifically; it does not gate every outbound HTTP call. General retry and backoff belong to \`HTTPClient\`.
- Persistence: versioned SwiftData schemas registered in a \`MailSyncMigrationPlan\`, from \`SchemaV1\` onward.

## Feature landing zones

- New AI capability or prompt change: \`MailSync/Services/ClaudeService.swift\`, validated by the AI contract command \`scripts/ai-contract-check/main.swift\`.
- Sync or reconciliation behavior: \`MailSync/Services/SyncCycle.swift\`, wired live in \`MailSync/Services/SyncService.swift\`.

## Verify gate

Build and test with xcodebuild on macOS. The AI request/response contract is exercised by \`scripts/ai-contract-check/main.swift\`.

## Unknowns

- The optional no-AI onboarding path exists in \`FirstRunCoordinator\`, but the exact setting that lets a run skip Claude was read from names, not bodies; confirm it before assuming AI is ever required.
- \`MailSync/Storage/ModelContainer+Setup.swift\` registers \`SchemaV1\` through \`SchemaV7\` in \`MailSyncMigrationPlan\` with the V5 stage absent; whether V5 was intentionally skipped is a decision for a maintainer to confirm.
- \`docs/ARCHITECTURE.md\` describes an activation and window model that current source contradicts — it predates the menu-bar shell wired in \`SyncService\`. Prefer the current source for runtime behavior and have a maintainer reconcile the stale document.
- Method bodies for \`SyncCycle\` step sequencing and \`ClaudeCLITransport\` retry were not inspected; those behaviors are inferred from signatures and should be verified against source.
`;

describe("mail-sync pilot knowledge regression", () => {
  it("accepts the corrected artifact and strips any delivery-wrapper preamble", () => {
    const wrapped = `I have enough grounding. Here is the knowledge artifact.\n\n${correctedProse}`;
    const validated = validateKnowledgeProse(wrapped);

    expect(validated).toBe(correctedProse);
    expect(validated).not.toMatch(/here is the knowledge artifact/i);
    expect(validated).not.toMatch(/enough grounding/i);
  });

  it("limits the Graph concurrency claim instead of gating all outbound HTTP", () => {
    expect(correctedProse).toMatch(/`RequestGate` bounds concurrent Microsoft Graph requests specifically/);
    expect(correctedProse).toMatch(/does not gate every outbound HTTP call/);
    expect(correctedProse).not.toMatch(/outbound HTTP is capped by a `RequestGate`/);
  });

  it("describes SyncCycle as dependency-injected orchestration, not pure orchestration", () => {
    expect(correctedProse).toMatch(/`SyncCycle` is dependency-injected orchestration that performs I\/O/);
    expect(correctedProse).not.toMatch(/`SyncCycle` \(pure orchestration\)/);
    expect(correctedProse).not.toMatch(/pure orchestration/);
  });

  it("documents the optional no-AI onboarding path and the real AI-contract command", () => {
    expect(correctedProse).toMatch(/optional no-AI path/);
    expect(correctedProse).toMatch(/skips Claude still reaches the inbox/);
    expect(correctedProse).toMatch(/scripts\/ai-contract-check\/main\.swift/);
  });

  it("surfaces the documentation/source conflict rather than blending the two", () => {
    expect(correctedProse).toMatch(/`docs\/ARCHITECTURE\.md` describes an activation and window model that current source contradicts/);
    expect(correctedProse).toMatch(/Prefer the current source for runtime behavior/);
    expect(correctedProse).toMatch(/reconcile the stale document/);
  });

  it("names the schema state including the absent V5 stage", () => {
    expect(correctedProse).toMatch(/`SchemaV1` through `SchemaV7`.*with the V5 stage absent/s);
  });

  it("keeps Unknowns to product/engineering decisions, free of map-truncation chatter", () => {
    const unknowns = correctedProse.slice(correctedProse.indexOf("## Unknowns"));
    expect(unknowns).not.toMatch(/more declarations/);
    expect(unknowns).not.toMatch(/omitted file/i);
    expect(unknowns).not.toMatch(/truncat/i);
    // Every bullet reads as something a maintainer should verify or decide.
    expect(unknowns).toMatch(/confirm/i);
    expect(unknowns).toMatch(/maintainer/i);
  });

  it("compiles with high structural coverage while flagging that behavior stays unverified", () => {
    const compiled = compileKnowledgeArtifact(correctedProse, pilotIndex);
    const grounding = checkGrounding(correctedProse, pilotIndex);

    // Broad structural coverage: the referenced nouns exist in the index.
    expect(grounding.notFound).toBe(0);
    expect(grounding.groundedRatio).toBe(1);
    // But the frontmatter must state that this ratio is not behavioral proof.
    expect(compiled.markdown).toContain("grounding_basis: structural-references");
    expect(compiled.markdown).toContain("it does not verify that the surrounding behavioral prose is correct");
    expect(parseKnowledgeArtifact(compiled.markdown).sha).toBe(pilotIndex.sha);
  });
});
