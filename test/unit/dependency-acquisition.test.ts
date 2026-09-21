import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { acquireDependencies } from "../../src/core/dependency-acquisition.js";
import { deriveDependencyInputs } from "../../src/core/dependency-inputs.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createPnpmFixture, type PnpmFixtureShape } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenario(shape: PnpmFixtureShape = {}): Promise<{ candidate: CandidateDescriptor; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-acq-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root, shape);
  const state = join(root, "state");
  const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
  candidates.push(candidate);
  return { candidate, state };
}

/**
 * Copies the host's corepack cache so the pinned pnpm is available without network.
 *
 * Returns false when the host has no usable cache, which lets a test skip the pnpm-level
 * assertions rather than quietly turning into a network test.
 */
async function seedCorepackCache(state: string): Promise<boolean> {
  const target = join(state, "dependency-acquisition", "corepack");

  // GitHub's pnpm/setup action installs the exact requested pnpm package under PNPM_HOME but
  // does not populate Corepack's cache. Reuse those already-installed bytes so this offline
  // gate is hermetic on fresh runners rather than depending on a developer's prior cache.
  const pnpmShim = process.env.PNPM_HOME ? join(process.env.PNPM_HOME, "pnpm") : null;
  if (pnpmShim) {
    try {
      const cli = await realpath(pnpmShim);
      const packageRoot = dirname(dirname(cli));
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === "pnpm" && manifest.version === "10.20.0") {
        const cachedRoot = join(target, "v1", "pnpm", "10.20.0");
        await cp(packageRoot, cachedRoot, { recursive: true });
        // Corepack uses this marker to recognize an already-installed package-manager cache.
        // The source bytes came from pnpm/action-setup and the exact package name/version was
        // checked above; this test-only marker is not dependency-integrity evidence.
        await writeFile(join(cachedRoot, ".corepack"), JSON.stringify({
          locator: { name: "pnpm", reference: "10.20.0" },
          bin: { pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" },
          hash: "sha512.review-lsp-test-fixture",
        }));
        return true;
      }
    } catch {
      // Fall through to ordinary Corepack cache discovery.
    }
  }

  for (const source of [
    join(homedir(), ".cache", "node", "corepack"),
    join(homedir(), "Library", "Caches", "node", "corepack"),
  ]) {
    try {
      const versions = await readdir(join(source, "v1", "pnpm"));
      if (!versions.includes("10.20.0")) continue;
      // Copy only the pinned version. The whole cache holds every package manager the host
      // has ever used, and copying it dominated this test's runtime.
      await cp(join(source, "v1", "pnpm", "10.20.0"), join(target, "v1", "pnpm", "10.20.0"), { recursive: true });
      return true;
    } catch {
      // Try the next candidate location.
    }
  }
  return false;
}

describe("explicit dependency acquisition", () => {
  it("reports ACQUISITION_REQUIRED instead of reaching the network for the package manager", async () => {
    const { candidate, state } = await scenario();
    const inputs = await deriveDependencyInputs(candidate);

    // Nothing is cached and the policy is offline, so corepack cannot fetch pnpm either.
    // Silently downloading the package manager would be a network access the offline policy
    // is supposed to forbid.
    const report = await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "OFFLINE" });

    expect(report.state).toBe("ACQUISITION_REQUIRED");
    expect(report.network_used).toBe(false);
    expect(report.limitation).toMatch(/pnpm 10\.20\.0 is not present/);
    expect(report.remediation).toMatch(/explicit network policy/);
  }, 120_000);

  it("reports ACQUISITION_REQUIRED when the store lacks the locked packages", async () => {
    const { candidate, state } = await scenario();
    const inputs = await deriveDependencyInputs(candidate);
    if (!await seedCorepackCache(state)) {
      // Without a cached package manager this cannot reach the store-shortfall path offline.
      return;
    }

    const report = await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "OFFLINE" });

    expect(report.state).toBe("ACQUISITION_REQUIRED");
    expect(report.network_used).toBe(false);
    expect(report.limitation).toMatch(/absent from the Review-LSP acquisition store/);
    expect(report.remediation).toMatch(/explicit network policy/);
  }, 120_000);

  it("rejects a stale lockfile as unsupported rather than suggesting network acquisition", async () => {
    const staleLockfile = [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "  packages/app: {}",
      "",
    ].join("\n");
    const { candidate, state } = await scenario({ lockfile: staleLockfile });
    const inputs = await deriveDependencyInputs(candidate);
    if (!await seedCorepackCache(state)) {
      throw new Error("P7 stale-lockfile gate requires cached pnpm 10.20.0");
    }

    const report = await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "OFFLINE" });

    expect(report.state).toBe("UNSUPPORTED");
    expect(report.network_used).toBe(false);
    expect(report.limitation).toMatch(/lockfile does not match/i);
    expect(report.remediation).toMatch(/candidate itself is inconsistent/i);
  }, 120_000);

  it("always records the policies the evidence depends on", async () => {
    const { candidate, state } = await scenario();
    const inputs = await deriveDependencyInputs(candidate);
    const report = await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "OFFLINE" });

    expect(report.script_policy).toBe("IGNORE_SCRIPTS");
    expect(report.lockfile_policy).toBe("FROZEN");
    // A production-only graph would drop the type packages the semantic environment needs.
    expect(report.dependency_graph).toBe("INCLUDES_DEV");
    expect(report.input_set_id).toBe(inputs.input_set_id);
    expect(report.store_directory).toContain("dependency-acquisition");
  }, 120_000);

  it.runIf(process.env.REVIEW_LSP_NETWORK_TESTS === "1")(
    "acquires the exact locked artifacts when the network policy authorizes it",
    async () => {
      const { candidate, state } = await scenario();
      const inputs = await deriveDependencyInputs(candidate);

      const acquired = await acquireDependencies({
        candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION",
      });
      expect(acquired.state).toBe("SATISFIED");
      expect(acquired.network_used).toBe(true);

      // The point of acquisition: what needed the network once must not need it again.
      const offline = await acquireDependencies({
        candidate, inputs, stateDirectory: state, networkPolicy: "OFFLINE",
      });
      expect(offline.state).toBe("SATISFIED");
      expect(offline.network_used).toBe(false);
    },
    600_000,
  );
});
