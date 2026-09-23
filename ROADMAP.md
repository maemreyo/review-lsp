# Roadmap

Review-LSP is intentionally developing from a narrow, verifiable vertical slice rather than expanding the API faster than the evidence model.

This is a direction document, not a compatibility promise.

## Current baseline — 0.1.0-alpha.6

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
- document diagnostics with deterministic TypeScript 6/7 transports, separate receipts, related-information provenance and engine-full-document completeness;
- candidate-contained TypeScript project-reference graphs admitted into deterministic environment evidence for the frozen Alpha.5 subset;
- exact candidate-bound TypeScript project ownership and semantic routing for the frozen Alpha.6 `files` / `include` / `exclude` / relative-`extends` subset, with only the minimal `allowJs` membership modifier needed to reproduce include extension eligibility.

Alpha.6 proves project ownership by admitted membership evidence rather than nearest-config proximity. Ambiguous or unsupported ownership fails closed instead of selecting a project heuristically, and resolving-project identity is bound into runtime/session reuse and semantic receipts. This remains narrower than the full TypeScript project model: default file discovery, package-based `extends`, broader config/package shapes, and arbitrary build-mode behavior remain separate work. Diagnostics remain semantic evidence for one admitted document, not project-wide build correctness. Symbols remain deferred.

This is not universal dependency-project support. Unsupported or ambiguous package-manager, workspace, config, package-export, local-directory and build-pipeline surfaces remain PARTIAL or UNSUPPORTED.

The frozen Alpha.6 implementation authority is `docs/design-notes/ALPHA6_PROJECT_OWNERSHIP_ROUTING_MASTER_PLAN.md`; Alpha.5 project-reference authority remains preserved in `docs/design-notes/ALPHA5_PROJECT_REFERENCE_MASTER_PLAN.md`, and the Alpha.4 semantic-operation authority remains historical context in `docs/design-notes/ALPHA4_SEMANTIC_IMPACT_MASTER_PLAN.md`.

## Near term — post-Alpha.6 hardening

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

After exact ownership/routing, continue strengthening the TypeScript support matrix without weakening admission:

- TypeScript default file-discovery semantics and broader config chains;
- package-based `extends` where it can be admitted exactly;
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
