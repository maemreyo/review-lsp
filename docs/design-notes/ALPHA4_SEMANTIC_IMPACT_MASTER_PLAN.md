# Alpha.4 semantic impact master plan

Status: FROZEN FOR IMPLEMENTATION — repository-cross-checked 2026-09-23.

Review note: the configured OpenCodeReview policy excludes Markdown as `unsupported_ext`, so no independent OCR semantic-review verdict is claimed for this document. The plan was cross-checked against the current types, semantic session, LSP driver, receipt validator, CLI/MCP surfaces, release docs, and alpha.3 Git baseline before freeze.

Baseline: `0.1.0-alpha.3` at `375cd9691412c944f592a87aedc3c207e1163b56`.

Target release direction: `0.1.0-alpha.4`.

Primary product statement:

> Exact-candidate semantic impact analysis with provenance.

## 1. Why this phase exists

Alpha.2 and alpha.3 moved the technical bottleneck away from basic candidate ingestion and dependency acquisition. Review-LSP now has an admitted pnpm dependency path, sealed dependency snapshots, semantic projections, constrained derived declarations, project-aligned TypeScript engine selection, runtime reuse, and candidate-local tarball acquisition.

The next gap is semantic usefulness for code review. Hover and definition answer what a symbol is and where it resolves. A reviewer also needs bounded evidence about where that symbol is used and which diagnostics the exact candidate produces.

This phase must not weaken the existing authority model to gain breadth.

## 2. Invariants

Every successful semantic answer remains bound to:

```text
exact Git candidate
+ exact admitted environment/snapshot/projection
+ exact semantic profile/toolchain
+ exact document + coordinate/request
+ exact operation result
= provenance-bound receipt
```

The following remain mandatory:

- never fall back to the ambient/live checkout;
- never use ambient `node_modules` as authority when a snapshot/projection is required;
- never silently download dependencies during semantic execution;
- never run arbitrary package lifecycle/build scripts to obtain semantic answers;
- never upgrade PARTIAL/UNKNOWN to VERIFIED because an LSP call happened to succeed;
- never claim semantic correctness merely because provenance is verified;
- keep Review-LSP core consumer-neutral and standalone from Workbench/OpenCodeReview policy.

## 3. P0 — reconcile alpha.3 durable authority

Before feature code, update durable docs so they describe the implementation that already exists.

Files to audit/update:

- `ROADMAP.md`
- `README.md` only where needed for consistency
- `docs/ARCHITECTURE.md`
- `docs/status/H0.md`
- `docs/status/H1.md`
- `docs/status/H3.md`
- `docs/status/H5.md`
- `docs/status/CURRENT.md`

Required wording distinction:

- dependency snapshot/acquisition/projection support is implemented;
- VERIFIED support exists only for the admitted subset;
- unsupported or ambiguous package-manager/workspace/config/build surfaces stay PARTIAL or UNSUPPORTED;
- arbitrary local-directory dependencies and arbitrary build pipelines remain outside authority;
- current public semantic operations remain hover + definition until alpha.4 implementation lands.

P0 is documentation reconciliation, not permission to widen product claims.

Acceptance:

- no current-status document states that dependency snapshot preparation does not exist;
- no current-status document implies universal dependency-project support;
- alpha.1 historical release notes remain historical and are not rewritten as if they described alpha.3;
- `git diff --check` passes;
- Markdown review limitations are recorded explicitly; no unsupported review PASS is claimed.

## 4. Alpha.4 vertical slice A — references

### 4.1 Public semantic contract

Add `references` as a first-class semantic operation.

The request is candidate/document/coordinate-bound and must explicitly bind whether the declaration itself is included.

Proposed request shape:

```ts
interface ReferencesQueryInput extends SemanticQueryInput {
  includeDeclaration: boolean;
}
```

The receipt must bind that option in the request identity. Do not hide it in result metadata.

### 4.2 Driver

Extend the LSP initialize client capabilities with references support and add a bounded `textDocument/references` method.

The driver must:

- require advertised `referencesProvider`;
- use the existing timeout/crash/late-response lifecycle;
- return the same RequestOutcome timing shape;
- not classify provenance itself.

### 4.3 Session and provenance

`SemanticSession.references()` must reuse the current session admission path:

1. candidate path validation;
2. exact candidate bytes;
3. coordinate context + optional expectation guard;
4. project-specific runtime/toolchain alignment;
5. LSP request;
6. classify every returned URI against admitted roots;
7. downgrade environment binding to PARTIAL if any result target is UNBOUND;
8. post-query candidate/profile/environment re-verification;
9. result byte-limit enforcement;
10. content-addressed receipt persistence.

Reference results should preserve the server response plus explicit provenance bindings rather than rewriting away LSP range information.

Each reference binding should identify, when possible:

- candidate source;
- dependency snapshot;
- derived workspace artifact;
- TypeScript/toolchain source;
- unbound target;
- relative path and content digest where authority permits.

The receipt must not claim that the LSP reference set is universally complete for dynamic/generated usage.

### 4.4 Receipt schema

Do not overload a string union without request-shape support.

Refactor semantic receipt typing so operation-specific request fields can be bound deterministically while preserving the v1 receipt content-addressing rules.

Preferred minimal-compatible direction:

- operation becomes `hover | definition | references`;
- request retains line/character and adds an optional, operation-bound `include_declaration` field used only by references;
- validation rejects impossible operation/request combinations rather than merely relying on TypeScript types.

If this cannot be done safely in v1, bump the receipt schema deliberately instead of creating ambiguous v1 payloads.

### 4.5 Surfaces

Only after core semantics are tested:

- public TypeScript exports;
- CLI `query ... references ...` with an explicit declaration-inclusion option;
- container query support;
- MCP tool `review_lsp_references`;
- candidate_info capabilities.

All surfaces must call the same core session operation.

### 4.6 References tests

At minimum:

- driver capability admission/refusal;
- self-contained candidate source references;
- reference result to dependency snapshot;
- reference result to derived workspace declaration/source where applicable;
- unbound URI downgrades environment evidence;
- includeDeclaration true/false is receipt-bound and changes request identity;
- coordinate expectation mismatch fails before LSP authority is emitted;
- mutation/tamper invalidation remains fail-closed;
- runtime reuse does not cross resolving-project identity;
- result-size limit still applies;
- CLI smoke;
- MCP stdio smoke;
- container plumbing type/argument coverage;
- receipt tamper validation.

Acceptance requires differential comparison against an independently started reference language server on representative fixtures where practical.

## 5. Alpha.4 vertical slice B — diagnostics

Diagnostics follow references, not in parallel.

The diagnostics authority is now frozen in:

`docs/design-notes/ALPHA4_DIAGNOSTICS_AUTHORITY.md`

The frozen Alpha.4 scope is document diagnostics only, with deterministic request/response transports:

- TypeScript 6 / legacy tsserver engines: the advertised `typescript.tsserverRequest` bridge with the fixed synchronous syntax + semantic + suggestion diagnostic commands;
- TypeScript 7 native LSP: standard `textDocument/diagnostic` when `diagnosticProvider` is advertised.

Bounded `publishDiagnostics` timing is not authoritative in Alpha.4 because silence is not a completion signal.

Diagnostics use a separate content-addressed receipt because point-query `review-lsp.receipt.v1` requires line/character coordinate context. The diagnostics receipt binds exact document bytes/version, candidate/environment/toolchain/session identity, transport, normalized diagnostics, related-information provenance, deterministic ordering, completeness semantics, and explicit limitations.

No diagnostics result may be described as project-wide build correctness.

Do not expose diagnostics publicly until the frozen authority contract is implemented, verified on both admitted engine generations, and candidate-bound reviewed.

## 6. Symbols

Document/workspace symbols are optional for alpha.4.

Decision gate after references + diagnostics:

- add only if they reuse the same evidence model without distorting scope;
- otherwise move to alpha.5.

No release dependency on symbols.

## 7. Provenance hardening

Alpha.4 should make provenance easier for consumers to reason about without adding consumer policy.

Where available, semantic results should expose:

- source vs dependency vs derived artifact vs toolchain classification;
- exact resolving project;
- exact semantic engine;
- project-toolchain alignment;
- coordinate context;
- operation-specific request options;
- per-target reason when classification is UNBOUND.

Potential later review-native primitive:

`find usages/callers affected by this candidate change`

This belongs above the primitive semantic core unless a generic, consumer-neutral contract emerges.

## 8. Consumer/provider ergonomics

Workbench remains a dogfood consumer, not the design center.

After references is stable, inspect current public exports before introducing any SDK. Prefer a small documented lifecycle over another abstraction layer:

```text
prepare candidate
-> acquire/prepare environment
-> open semantic session
-> semantic queries
-> receipts
-> close
```

No Workbench-specific policy may enter Review-LSP core.

## 9. Beta evidence gate

Before beta, favor stronger real-world TypeScript evidence over more languages.

Representative corpus should cover:

- simple TypeScript package;
- pnpm monorepo;
- project references;
- dependency-heavy application;
- generated `.d.ts`;
- candidate-local vendored `.tgz`;
- multiple TypeScript versions;
- multiple workspace/config patterns;
- package exports/imports;
- source/dependency/derived definition and reference routing.

Retain benchmark and compatibility history across releases.

## 10. Release gates for alpha.4

Do not bump or publish until scope is frozen.

Required on exact release candidate:

- targeted unit/acceptance tests for new operations;
- `pnpm check`;
- package smoke;
- MCP stdio smoke;
- cache-crash smoke remains green;
- compatibility matrix on supported macOS/Linux Node versions;
- Linux container isolation job;
- benchmark;
- real Workbench dogfood using the published/provider candidate surface;
- candidate-bound independent code review;
- clean successor review for any blocking finding;
- exact Git tag/release/npm artifact identity checks.

While prerelease:

- publish under `alpha`;
- do not move `latest`.

## 11. Execution order

1. Freeze this plan through independent review.
2. Complete P0 documentation reconciliation and review/commit it separately.
3. Implement references core types + driver + session provenance.
4. Add references unit and acceptance fixtures.
5. Expose references through CLI/container/MCP/public exports.
6. Run targeted gates, then full `pnpm check`.
7. Independently review references candidate and repair/re-review findings.
8. Dogfood references through Workbench without changing standalone-core policy.
9. Freeze diagnostics authority contract.
10. Implement diagnostics only after that review.
11. Decide symbols scope.
12. Run full alpha.4 release gates.
13. Publish only from an exact reviewed candidate.

## 12. Non-goals

Not alpha.4 scope:

- Windows support;
- remote MCP;
- signed receipts;
- arbitrary package build pipelines;
- arbitrary local-directory dependencies;
- broad new language profiles;
- weakening fail-closed workspace/config/package admission;
- embedding code-review policy into Review-LSP core.
