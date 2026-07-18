import { defineConfig } from "vitest/config";

// The prototype is deliberately outside the pnpm workspace and outside the root
// vitest run: it carries its own native tree-sitter dependencies and is meant to
// be deleted, not maintained. Run it with `npm test` from this directory.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
