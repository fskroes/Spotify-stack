import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "demo-repos/**"],
    // The hermetic e2e installs demo-repo deps and runs real eslint/tsc/vitest
    // inside a temp workspace; give it room.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
