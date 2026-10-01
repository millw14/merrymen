import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest, for the pure logic only.
 *
 * The store and the feed types are plain TypeScript with no React Native imports,
 * so they can be tested in node without Metro, a simulator, or jest-expo — which
 * would drag in a whole RN transform pipeline to test a reducer. Anything that
 * touches a React Native module belongs in a different runner; keep this one able
 * to stay fast, because a slow test for the hot path won't get run.
 *
 * The alias is hand-written rather than read from tsconfig via a plugin: one line,
 * one fewer dependency, and it fails loudly if it ever drifts from tsconfig.json.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@merrymen/core": path.resolve(__dirname, "..", "packages", "core", "src", "index.ts"),
      "@merrymen/recover": path.resolve(__dirname, "..", "worker", "src", "recover.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
