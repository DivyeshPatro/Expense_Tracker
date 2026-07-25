import { defineConfig } from "vitest/config";
import path from "path";

// Unit suite: pure, no database. `*.integration.test.ts` is excluded so this
// stays runnable anywhere — including the CI job that has no Postgres service.
// Integration tests run via `npm run test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
