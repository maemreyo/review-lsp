import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "acceptance", include: ["test/acceptance/**/*.test.ts"], testTimeout: 30_000 } }
    ]
  }
});
