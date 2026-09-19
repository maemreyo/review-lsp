import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Unit tests here drive real Git, pnpm and filesystem work rather than mocks, and this
      // host shows heavy background load, so the 5s default expires on cost rather than on a
      // defect. Individual tests still set tighter or looser budgets where that is meaningful.
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 60_000 } },
      { test: { name: "acceptance", include: ["test/acceptance/**/*.test.ts"], testTimeout: 30_000 } }
    ]
  }
});
