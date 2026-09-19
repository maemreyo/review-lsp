/**
 * Paired A/B measurement of candidate preparation.
 *
 * This host shows heavy, bursty background load, so two separately recorded runs are not
 * comparable: a slow run may reflect contention rather than implementation. This harness
 * loads two builds in one process and alternates samples between them, so both see the same
 * conditions and the reported delta is paired rather than cross-run.
 *
 *   node scripts/ab-prepare.mjs --baseline DIR [--samples N] [--out FILE]
 *
 * `--baseline` is a built `dist` tree of the implementation to compare against; the current
 * repository's `dist` is the candidate implementation.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { createMonorepoRepo } from "../dist/test/helpers/monorepo.js";

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

const round = (value) => Math.round(value * 1000) / 1000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function stats(values) {
  return {
    samples: values.length,
    min_ms: round(Math.min(...values)),
    median_ms: round(median(values)),
    max_ms: round(Math.max(...values)),
  };
}

const args = process.argv.slice(2);
const baselineDist = option(args, "--baseline");
const samples = Number(option(args, "--samples") ?? "5");
const outPath = option(args, "--out");
if (!baselineDist) throw new Error("--baseline <dist dir> is required");
if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error("--samples must be a positive integer");

const baseline = await import(pathToFileURL(join(resolve(baselineDist), "src", "index.js")).href);
const candidateImpl = await import("../dist/src/index.js");

const root = await mkdtemp(join(tmpdir(), "review-lsp-ab-"));

try {
  const fixture = await createMonorepoRepo(root);

  const results = {
    baseline: { cold: [], warm: [], verify: [] },
    candidate: { cold: [], warm: [], verify: [] },
  };
  const identities = new Set();

  async function sample(impl, bucket, index, tag) {
    const stateDirectory = join(root, `state-${tag}-${index}`);

    const coldStart = performance.now();
    const cold = await impl.prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory });
    bucket.cold.push(performance.now() - coldStart);

    const warmStart = performance.now();
    const warm = await impl.prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory });
    bucket.warm.push(performance.now() - warmStart);
    if (warm.source_manifest_sha256 !== cold.source_manifest_sha256) {
      throw new Error(`${tag}: warm preparation produced a different manifest than cold preparation`);
    }

    const verifyStart = performance.now();
    await impl.verifyCandidateIntegrity(cold);
    bucket.verify.push(performance.now() - verifyStart);

    // Content identity only: candidate_id binds the absolute repository path, which is
    // identical here, but the manifest digest is what must agree between implementations.
    identities.add(JSON.stringify({
      schema_version: cold.schema_version,
      commit_oid: cold.commit_oid,
      tree_oid: cold.tree_oid,
      source_manifest_sha256: cold.source_manifest_sha256,
      isolation: cold.isolation,
      entry_count: cold.entries.length,
      tracked_bytes: cold.entries.reduce((total, entry) => total + entry.byte_count, 0),
    }));

    await impl.removeCandidate(cold).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  // Alternate, and flip which implementation goes first, so neither systematically absorbs
  // the cost of a cold filesystem cache or a load burst.
  for (let index = 0; index < samples; index += 1) {
    if (index % 2 === 0) {
      await sample(baseline, results.baseline, index, "baseline");
      await sample(candidateImpl, results.candidate, index, "candidate");
    } else {
      await sample(candidateImpl, results.candidate, index, "candidate");
      await sample(baseline, results.baseline, index, "baseline");
    }
  }

  if (identities.size !== 1) {
    throw new Error(`candidate evidence diverged between implementations: ${[...identities].join(" vs ")}`);
  }

  const report = {
    schema: "review-lsp.candidate-ab.v1",
    recorded_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: cpus().length,
    loadavg_1m: round(loadavg()[0]),
    samples,
    identity_parity: "IDENTICAL",
    identity: JSON.parse([...identities][0]),
    baseline: {
      cold_prepare: stats(results.baseline.cold),
      warm_prepare: stats(results.baseline.warm),
      integrity_verification: stats(results.baseline.verify),
    },
    candidate: {
      cold_prepare: stats(results.candidate.cold),
      warm_prepare: stats(results.candidate.warm),
      integrity_verification: stats(results.candidate.verify),
    },
    speedup: {
      cold_prepare: round(median(results.baseline.cold) / median(results.candidate.cold)),
      warm_prepare: round(median(results.baseline.warm) / median(results.candidate.warm)),
      integrity_verification: round(median(results.baseline.verify) / median(results.candidate.verify)),
    },
    semantics: [
      "Paired samples taken alternately in one process on one fixture.",
      "integrity_verification is unchanged code reading the same bytes: a speedup near 1.0",
      "indicates both implementations saw comparable host conditions.",
    ].join(" "),
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await writeFile(resolve(outPath), serialized);
  process.stdout.write(serialized);
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
