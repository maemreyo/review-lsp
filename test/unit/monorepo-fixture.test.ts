import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("ignores hostile system and global Git configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-fixture-hostile-"));
    roots.push(root);

    // Settings a developer may legitimately have set on their machine, each of which would
    // change the resulting commit OID if the fixture inherited ambient Git configuration.
    const hostileConfig = join(root, "hostile.gitconfig");
    await writeFile(hostileConfig, [
      "[init]",
      "\tdefaultObjectFormat = sha256",
      "\tdefaultBranch = trunk",
      "[core]",
      "\tautocrlf = true",
      "\tfileMode = false",
      "[commit]",
      "\tgpgsign = true",
      "[user]",
      "\tname = Hostile Host",
      "\temail = hostile@example.invalid",
      "",
    ].join("\n"));

    const shape = { packages: 2, modulesPerPackage: 3, paddingBytesPerModule: 0 };
    const clean = await createMonorepoRepo(join(root, "clean"), shape);

    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_CONFIG_SYSTEM = hostileConfig;
    try {
      const hostile = await createMonorepoRepo(join(root, "hostile"), shape);
      expect(hostile.commit).toBe(clean.commit);
      expect(hostile.entryCount).toBe(clean.entryCount);
      expect(hostile.trackedBytes).toBe(clean.trackedBytes);
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousSystem;
    }
  }, 30_000);

  it("generates a realistic entry count with non-regular entries covered", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-fixture-shape-"));
    roots.push(root);

    const fixture = await createMonorepoRepo(root, { packages: 6, modulesPerPackage: 20, paddingBytesPerModule: 100 });

    // Hundreds of files, not the two-file A/B fixture: per-blob ingestion cost only shows at scale.
    expect(fixture.entryCount).toBeGreaterThan(100);
    expect(fixture.trackedBytes).toBeGreaterThan(0);
  });
});
