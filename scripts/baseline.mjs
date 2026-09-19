/**
 * P0 candidate-preparation baseline harness.
 *
 * Records the identity of an exact candidate together with the cost of producing it, so a
 * later ingestion change can only claim an improvement while reproducing byte-identical
 * candidate evidence. Identity is the gate; timings are the observation.
 *
 *   node scripts/baseline.mjs [--repo DIR --commit REV] [--label NAME]
 *                             [--out FILE] [--skip-semantic] [--iterations N]
 *
 * With no --repo, a deterministic pnpm-workspace-shaped TypeScript monorepo fixture is
 * generated; its commit OID is stable across machines and runs.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createTypeScriptProfile,
  prepareCandidate,
  removeCandidate,
  SemanticSession,
  verifyCandidateIntegrity,
} from "../dist/src/index.js";
import { createMonorepoRepo } from "../dist/test/helpers/monorepo.js";

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[index]);
}

function summary(values) {
  if (values.length === 0) return null;
  return {
    samples: values.length,
    min_ms: percentile(values, 0),
    median_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: percentile(values, 100),
  };
}

const args = process.argv.slice(2);
const repoOption = option(args, "--repo");
const commitOption = option(args, "--commit");
const label = option(args, "--label") ?? (repoOption ? "external-repo" : "monorepo-fixture");
const outPath = option(args, "--out");
const skipSemantic = flag(args, "--skip-semantic");
const iterations = Number(option(args, "--iterations") ?? "5");
const prepareSamples = Number(option(args, "--prepare-samples") ?? "3");
if (repoOption && !commitOption) throw new Error("--repo requires --commit");
if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error("--iterations must be a positive integer");
if (!Number.isSafeInteger(prepareSamples) || prepareSamples <= 0) throw new Error("--prepare-samples must be a positive integer");

const root = await mkdtemp(join(tmpdir(), "review-lsp-baseline-"));
const coldState = join(root, "state-cold");
let candidate;
let fixture;

try {
  let repo;
  let commit;
  if (repoOption) {
    repo = resolve(repoOption);
    commit = commitOption;
  } else {
    fixture = await createMonorepoRepo(root);
    repo = fixture.repo;
    commit = fixture.commit;
  }

  // Preparation is sampled rather than timed once: this host shows heavy, bursty background
  // load, and a single sample cannot distinguish an implementation change from contention.
  // `integrity_verification` is pure file I/O over the same bytes in every implementation,
  // so it doubles as a contention proxy when comparing two recorded runs.
  const coldSamples = [];
  const warmSamples = [];
  const verifySamples = [];

  for (let sample = 0; sample < prepareSamples; sample += 1) {
    const sampleState = join(root, `state-${sample}`);

    const coldStart = performance.now();
    const cold = await prepareCandidate({ repo, commit, stateDirectory: sampleState });
    coldSamples.push(performance.now() - coldStart);

    // Warm: the identical candidate is already retained under the same state directory.
    const warmStart = performance.now();
    const warm = await prepareCandidate({ repo, commit, stateDirectory: sampleState });
    warmSamples.push(performance.now() - warmStart);
    if (warm.candidate_id !== cold.candidate_id || warm.source_manifest_sha256 !== cold.source_manifest_sha256) {
      throw new Error("warm prepare returned a different candidate identity than cold prepare");
    }

    const verifyStart = performance.now();
    await verifyCandidateIntegrity(cold);
    verifySamples.push(performance.now() - verifyStart);

    if (candidate) await removeCandidate(cold).catch(() => undefined);
    else candidate = cold;
  }

  const trackedBytes = candidate.entries.reduce((total, entry) => total + entry.byte_count, 0);
  const kinds = candidate.entries.reduce((counts, entry) => {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }, {});

  let profileAdmissionMs = null;
  const sessionStarts = [];
  const hovers = [];
  const definitions = [];

  if (!skipSemantic && !repoOption) {
    const profileStart = performance.now();
    const profile = await createTypeScriptProfile();
    profileAdmissionMs = performance.now() - profileStart;

    // packages/pkg-0/src/module-0.ts line 5: `export const shape0: Shape0 = { ... };`
    const queryPath = "packages/pkg-0/src/module-0.ts";
    const hoverPosition = { path: queryPath, line: 5, character: 13 };
    const definitionPosition = { path: queryPath, line: 5, character: 21 };

    for (let index = 0; index < iterations; index += 1) {
      const sessionStart = performance.now();
      const session = await SemanticSession.create({ candidate, profile, stateDirectory: coldState });
      sessionStarts.push(performance.now() - sessionStart);
      try {
        const hoverStart = performance.now();
        const hover = await session.hover(hoverPosition);
        hovers.push(performance.now() - hoverStart);
        if (!JSON.stringify(hover.result).includes("Shape0")) {
          throw new Error("baseline hover did not return the expected candidate semantics");
        }

        const definitionStart = performance.now();
        const definition = await session.definition(definitionPosition);
        definitions.push(performance.now() - definitionStart);
        if (!JSON.stringify(definition.result).includes("module-0.ts")) {
          throw new Error("baseline definition did not bind the expected candidate source");
        }
      } finally {
        await session.close();
      }
    }
  }

  const report = {
    schema: "review-lsp.candidate-baseline.v1",
    label,
    recorded_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    identity: {
      // Derived purely from candidate content. These must survive every ingestion change
      // unchanged, and they are the fields a parity check compares across runs and hosts.
      content: {
        schema_version: candidate.schema_version,
        git_object_format: candidate.git_object_format,
        commit_oid: candidate.commit_oid,
        tree_oid: candidate.tree_oid,
        source_manifest_sha256: candidate.source_manifest_sha256,
        isolation: candidate.isolation,
        entry_count: candidate.entries.length,
        tracked_bytes: trackedBytes,
        entry_kinds: kinds,
      },
      // `repository_identity` hashes the absolute git directory, and `candidate_id` binds it.
      // Both are therefore stable for a given repository location but differ between a
      // temporary fixture checkout and any other path, so neither can be compared across
      // runs. Recorded for traceability, excluded from the parity contract.
      location_bound: {
        candidate_id: candidate.candidate_id,
        repository_identity: candidate.repository_identity,
      },
    },
    parity_contract: "identity.content must match exactly; identity.location_bound is path-derived and is not comparable across runs",
    fixture: fixture
      ? { kind: "generated-monorepo", deterministic_commit: fixture.commit }
      : { kind: "external-repo", commit: candidate.commit_oid },
    candidate_preparation: {
      samples: prepareSamples,
      cold_prepare: summary(coldSamples),
      warm_prepare: summary(warmSamples),
      integrity_verification: summary(verifySamples),
    },
    host_load: {
      loadavg_1m: Math.round(loadavg()[0] * 100) / 100,
      loadavg_5m: Math.round(loadavg()[1] * 100) / 100,
      cpus: cpus().length,
      note: "recorded after the run; compare integrity_verification between records before comparing preparation cost",
    },
    dependency_snapshot: {
      cold_ms: null,
      warm_ms: null,
      note: "no dependency snapshot provider exists before P2; this slot is reserved and must be filled by P2",
    },
    semantic: skipSemantic || repoOption
      ? { note: "semantic phase skipped; candidate declares dependencies or --skip-semantic was passed" }
      : {
          profile_admission_ms: round(profileAdmissionMs),
          session_start: summary(sessionStarts),
          hover: summary(hovers),
          definition: summary(definitions),
        },
    semantics: "observational baseline on this host; identity parity is the gate, timings are not release thresholds",
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await writeFile(resolve(outPath), serialized);
  process.stdout.write(serialized);
} finally {
  if (candidate) await removeCandidate(candidate).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
