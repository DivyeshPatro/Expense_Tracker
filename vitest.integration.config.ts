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
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
