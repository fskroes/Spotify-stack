import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `test/` at the root holds checks that belong to no single workspace:
    // documentation drift locks, and invariants over a *pair* of packages that
    // either one could be edited out of agreement with.
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "demo-repos/**"],
    // The hermetic e2e installs demo-repo deps and runs real eslint/tsc/vitest
    // inside a temp workspace; give it room.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
