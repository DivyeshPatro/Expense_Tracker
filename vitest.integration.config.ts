import { defineConfig } from "vitest/config";
import path from "path";

// Integration suite: needs a live Postgres via DATABASE_URL, with migrations
// applied. These tests share one database, so they run single-file/serially to
// keep row counts and balances deterministic.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Vitest's 5s default is a unit-test budget. These tests do real database
    // work — the recurring catch-up case alone commits 60 transactions in
    // sequence, which already ran at ~3s and tipped over the limit on a loaded
    // machine. Slow is expected here; hanging is not, so the ceiling is raised
    // rather than removed.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
