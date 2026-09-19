import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMonorepoRepo } from "../helpers/monorepo.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("monorepo baseline fixture", () => {
  it("produces a reproducible commit identity across independent generations", async () => {
    const first = await mkdtemp(join(tmpdir(), "review-lsp-fixture-a-"));
    const second = await mkdtemp(join(tmpdir(), "review-lsp-fixture-b-"));
    roots.push(first, second);

    const shape = { packages: 2, modulesPerPackage: 3, paddingBytesPerModule: 0 };
    const a = await createMonorepoRepo(first, shape);
    const b = await createMonorepoRepo(second, shape);

    // A baseline that cannot be regenerated bit-for-bit cannot prove candidate parity later.
    expect(a.commit).toBe(b.commit);
    expect(a.entryCount).toBe(b.entryCount);
    expect(a.trackedBytes).toBe(b.trackedBytes);
  });

  it("generates a realistic entry count with non-regular entries covered", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-fixture-shape-"));
    roots.push(root);

    const fixture = await createMonorepoRepo(root, { packages: 6, modulesPerPackage: 20, paddingBytesPerModule: 100 });

    // Hundreds of files, not the two-file A/B fixture: per-blob ingestion cost only shows at scale.
    expect(fixture.entryCount).toBeGreaterThan(100);
    expect(fixture.trackedBytes).toBeGreaterThan(0);
  });
});
