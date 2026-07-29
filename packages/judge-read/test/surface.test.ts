import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JUDGE_READ_TOOLS } from "../src/read.js";

/**
 * The tool surface is *one* declaration, and this file is what keeps it one.
 *
 * ADR-0011 exists because two transports carried two different capabilities
 * under a single name. A design where each transport declares its own tools
 * re-creates that the first time someone edits one adapter — so the array is
 * the surface, and no adapter may name a tool literally.
 */
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("JUDGE_READ_TOOLS", () => {
  it("declares the v1 surface: read a file by path, and find paths by glob", () => {
    // `find` is not optional (spec §3.3): a read-by-path-only surface lets the
    // judge open only files it could already name, which is text-only blindness
    // one layer down — and the false green behind ADR-0011 needed a file the
    // diff never mentioned.
    expect(JUDGE_READ_TOOLS.map((t) => t.name)).toEqual(["read_file", "find"]);
  });

  it("carries a description and an input schema for every tool", () => {
    // Descriptions are part of the surface, not documentation: two judges told
    // different things about the same tool are two different reviewers again.
    for (const tool of JUDGE_READ_TOOLS) {
      expect(tool.description.length, `${tool.name} has no description`).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("is frozen all the way down, so no adapter can reshape it in passing", () => {
    expect(Object.isFrozen(JUDGE_READ_TOOLS)).toBe(true);
    for (const tool of JUDGE_READ_TOOLS) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.inputSchema)).toBe(true);
      expect(Object.isFrozen(tool.inputSchema.properties)).toBe(true);
    }
  });

  it("carries no executable payload — it is the wire shape both transports send", () => {
    // The handlers live next to the declaration but never travel with it: a
    // function on a tool entry is not serialisable to MCP or to the API.
    for (const tool of JUDGE_READ_TOOLS) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });

  it("is the only place in the package that names a tool", () => {
    // read.js holds the declaration. Every other module — today none, from the
    // MCP server on, one — must reach the surface by iterating it.
    const names = JUDGE_READ_TOOLS.map((t) => t.name);
    const offenders = readdirSync(srcDir)
      .filter((f) => f.endsWith(".js") && f !== "read.js")
      .flatMap((f) => {
        const source = readFileSync(path.join(srcDir, f), "utf8");
        return names.filter((name) => source.includes(name)).map((name) => `${f} names "${name}"`);
      });

    expect(offenders, `a transport adapter named a tool literally: ${offenders.join(", ")}`).toEqual([]);
  });
});
