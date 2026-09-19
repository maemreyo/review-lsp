# Candidate preparation baselines

## Which file answers what

| File | Authoritative for |
| --- | --- |
| `P0_CANDIDATE_BASELINE.json` | The frozen pre-P1 reference: candidate content identity, and the cost of preparation, semantic session start, hover and definition before any ingestion change. |
| `P1_AB_PREPARE.json` | The P1 ingestion result. This is the only authoritative preparation comparison. |

## Why the comparison is paired

Preparation cost on this host cannot be compared across separately recorded runs. Background
load is heavy and bursty — a real-time antivirus scanner reacts to the hundreds of files each
fixture materializes — and observed single-run medians for the *same* implementation ranged
from roughly 0.9 s to 7.9 s depending only on when the run happened.

`scripts/ab-prepare.mjs` therefore loads both builds into one process, uses one fixture, and
alternates samples between them, flipping which implementation goes first. Both see the same
conditions, so the reported delta is paired.

The harness reports `integrity_verification` as a control: it is unchanged code reading the
same bytes in both builds, so a ratio near 1.0 means neither implementation got a favourable
window. In the recorded run the control is **0.686** — the P1 build's control was *slower* —
so the preparation speedup below is conservative rather than inflated.

## Recorded result

Fixture: 522 entries, 599,810 tracked bytes, generated pnpm-workspace TypeScript monorepo.

| Metric | Pre-P1 (median) | P1 (median) | Ratio |
| --- | ---: | ---: | ---: |
| Cold prepare | 42,089 ms | 742 ms | 56.7× |
| Warm prepare | 39,018 ms | 292 ms | 133.5× |
| Integrity verification (control) | 105 ms | 153 ms | 0.69× |

Candidate content identity was byte-identical between the two implementations; the A/B
harness fails closed if it is not.

## Identity parity contract

`identity.content` is derived purely from candidate content and must match exactly across
implementations, runs and hosts.

`identity.location_bound` — `candidate_id` and `repository_identity` — is **not** comparable
across runs. `repository_identity` hashes the absolute Git directory and `candidate_id` binds
it, so a candidate prepared from two different checkout paths of the same commit has the same
content identity and a different `candidate_id`. That is by design: a candidate is bound to
the repository it came from. It means parity must be asserted on `identity.content`.

## Reproducing

```bash
node scripts/baseline.mjs --prepare-samples 5 --out docs/baselines/P0_CANDIDATE_BASELINE.json
```

For the paired comparison, build the implementation to compare against into a separate tree
inside the repository (so it resolves `node_modules`), then:

```bash
node scripts/ab-prepare.mjs --baseline .ab-baseline --samples 5 --out docs/baselines/P1_AB_PREPARE.json
```

Timings are observational on one host. Identity parity is the gate; no release threshold is
implied by any number here.
