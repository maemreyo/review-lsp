# Roadmap

Review-LSP is intentionally developing from a narrow, verifiable vertical slice rather than expanding the API faster than the evidence model.

This is a direction document, not a compatibility promise.

## Current baseline — 0.1.0-alpha.4

The dependency-aware TypeScript path is implemented for an admitted subset:

- content-addressed pnpm 10 dependency inputs, acquisition and sealed snapshots;
- source + dependency semantic projections;
- constrained derived TypeScript declaration artifacts;
- workspace/config/package-shape fail-closed gates;
- candidate-selected TypeScript engines where the execution profile can admit them;
- candidate-local `.tgz` dependencies referenced by frozen pnpm `file:` entries;
- persistent semantic runtime reuse;
- hover and definition with provenance-bound receipts;
- references with explicit declaration-inclusion identity and per-target provenance;
- document diagnostics with deterministic TypeScript 6/7 transports, separate receipts, related-information provenance and engine-full-document completeness.

Diagnostics are semantic evidence for one admitted document and are not project-wide build correctness. Symbols remain deferred because Alpha.4 did not need to widen the evidence surface further.

This is not universal dependency-project support. Unsupported or ambiguous package-manager, workspace, config, package-export, local-directory and build-pipeline surfaces remain PARTIAL or UNSUPPORTED.

The frozen Alpha.4 implementation authority remains `docs/design-notes/ALPHA4_SEMANTIC_IMPACT_MASTER_PLAN.md`.

## Near term — post-Alpha.4 hardening

### Richer provenance

Improve operation-specific result metadata where useful:

- candidate source vs dependency source;
- generated/derived artifact vs real source;
- toolchain-owned targets;
- resolving project;
- exact semantic engine;
- coordinate/request guards;
- per-target classification reasons.

### Consumer integration

Make external Review-LSP provider setup simpler for code-review tools while keeping the standalone core consumer-neutral.

Prefer a documented lifecycle before adding a new SDK layer:

```text
prepare candidate
-> acquire/prepare environment
-> open semantic session
-> semantic queries
-> receipts
-> close
```

### General-project completeness

After semantic breadth is stable, continue strengthening the TypeScript support matrix without weakening admission:

- project references;
- more TypeScript config chains;
- more package exports/imports shapes;
- more workspace routing cases;
- broader pnpm project shapes backed by exact evidence.

Arbitrary local-directory dependencies and arbitrary package lifecycle/build pipelines require separate authority designs. They must not be enabled by simply executing package scripts.

### Release ergonomics and beta evidence

- clearer artifact/provider identity for consumers;
- easier container-image distribution;
- representative real-repository compatibility corpus;
- retained benchmark and compatibility history.

## Later

Potential additional language profiles should be added only when their server/toolchain/config/dependency inputs can be admitted with equivalent provenance.

Independent later tracks include Windows, remote MCP and signed receipts.

## Non-goals for the current alpha line

- treating live editor state as review authority;
- silently downloading dependencies during semantic execution;
- running arbitrary package scripts to make semantics work;
- claiming semantic correctness from an LSP response;
- turning PARTIAL or UNKNOWN evidence into VERIFIED;
- building consumer-specific policy into the standalone core.
