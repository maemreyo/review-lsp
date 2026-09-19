import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests drive real Git, pnpm and filesystem work rather than mocks. Running many
    // such files at full parallelism on a contended host makes them expire on cost rather
    // than on a defect, so worker concurrency is capped here.
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          // Generous by design; individual tests set tighter budgets where that is meaningful.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
      { test: { name: "acceptance", include: ["test/acceptance/**/*.test.ts"], testTimeout: 30_000 } }
    ]
  }
});
