import test from "node:test";
import assert from "node:assert/strict";
import { asArray, parseArgs } from "../src/lib/args.js";

test("parseArgs reads a --key value pair", () => {
  assert.deepEqual(parseArgs(["--name", "daily"]), { name: "daily" });
});

test("parseArgs treats a flag followed by another option as true", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--name", "daily"]), {
    "dry-run": true,
    name: "daily",
  });
});

test("parseArgs treats a trailing flag as true", () => {
  assert.deepEqual(parseArgs(["--name", "daily", "--dry-run"]), {
    name: "daily",
    "dry-run": true,
  });
});

test("parseArgs collects repeated keys into an array", () => {
  const args = parseArgs(["--tag", "a", "--tag", "b", "--tag", "c"]);
  assert.deepEqual(args, { tag: ["a", "b", "c"] });
});

test("parseArgs skips tokens that are not flags or flag values", () => {
  assert.deepEqual(parseArgs(["stray", "--name", "daily"]), { name: "daily" });
});

test("parseArgs returns an empty object for no arguments", () => {
  assert.deepEqual(parseArgs([]), {});
});

test("asArray normalizes undefined, scalars, and arrays", () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray("x"), ["x"]);

  const list = ["x", "y"];
  assert.equal(asArray(list), list);
});
