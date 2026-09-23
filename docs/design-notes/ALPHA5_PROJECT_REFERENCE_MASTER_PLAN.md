# Alpha.5 project-reference hardening master plan

Status: FROZEN FOR IMPLEMENTATION — repository-cross-checked 2026-09-23.

Baseline: `0.1.0-alpha.4` at `ce2e3b718ee59fd6c018c7b17cf7158b2dd31ff9`.

Target release direction: `0.1.0-alpha.5`.

Primary product statement:

> Admit and bind candidate-contained TypeScript project-reference graphs without weakening exact-candidate, environment, or toolchain provenance.

Review note: the current OpenCodeReview policy does not semantically review Markdown. This plan is therefore frozen from repository/code cross-check plus executable verification where applicable; no unsupported Markdown semantic-review PASS is claimed.

## 1. Why Alpha.5 is this slice

Alpha.4 deliberately widened semantic breadth with references and document diagnostics. The current roadmap does not designate symbols as the next release. Its near-term priorities are post-Alpha.4 hardening, richer provenance, general-project completeness, consumer integration, and beta evidence.

The current implementation has a concrete general-project completeness gap:

- `resolveProjectForDocument()` explicitly uses the nearest enclosing config rather than evaluating TypeScript `references` / inclusion ownership;
- environment admission collects config digests and checks a narrow `extends` boundary, but does not validate or bind a TypeScript project-reference graph;
- a candidate may therefore declare malformed, escaping, missing, or otherwise unadmitted project references without that graph being represented as explicit environment evidence.

Project references are already named in the repository roadmap as a next general-project-completeness target. This slice hardens that boundary before adding more semantic operations.

## 2. Goal

For the admitted TypeScript subset, Review-LSP must be able to say exactly which candidate-contained project-reference graph was observed and whether it is admissible.

For a successful strong environment claim:

1. every admitted `references` edge is structurally valid;
2. every referenced config resolves inside candidate authority;
3. referenced config bytes are candidate-bound;
4. graph traversal is deterministic and bounded;
5. cycles, ambiguity, missing targets, escaping paths, and unsupported shapes fail closed or force PARTIAL;
6. the graph identity is bound into the environment manifest;
7. semantic queries continue to execute against the exact candidate/projection and preserve existing source/toolchain/isolation claims.

The first implementation is intentionally narrow. It does not attempt to reproduce every TypeScript build-mode rule.

## 3. Non-goals

Not Alpha.5 scope:

- document symbols;
- workspace symbols;
- workspace/project-wide diagnostics;
- call hierarchy;
- type hierarchy;
- remote MCP;
- signed receipts;
- Windows compatibility claims;
- additional language profiles;
- arbitrary package build pipelines;
- arbitrary local-directory dependencies;
- a generic config-graph framework;
- a new daemon or provider SDK;
- consumer-specific Workbench policy in Review-LSP core;
- claiming that an admitted project-reference graph proves compiler/build correctness.

Symbols remain backlog until a later scope decision.

## 4. Authority and invariants

Alpha.5 preserves the existing authority chain:

```text
exact Git candidate
+ admitted dependency snapshot/projection when required
+ admitted candidate-contained TypeScript config graph
+ exact semantic profile/project toolchain
+ exact semantic request/document
= provenance-bound semantic evidence
```

Mandatory invariants:

- no ambient/live checkout fallback;
- no ambient `node_modules` authority;
- no implicit network during semantic execution;
- no arbitrary package scripts;
- no PARTIAL/UNKNOWN -> VERIFIED upgrade because an LSP answer looks plausible;
- no semantic-correctness claim from provenance alone;
- source integrity before and after queries remains unchanged;
- Workbench remains an external consumer/dogfood environment.

## 5. Project-reference admission contract

### 5.1 Supported first shape

Alpha.5 admits `references` only when the property is absent or is an array of objects with one string `path` field.

The referenced path must be candidate-relative after resolution from the declaring config directory.

Initial accepted targets mirror TypeScript's project-reference path rule observed against the admitted TypeScript 6 baseline:

- a path ending in `.json` resolves to that explicit candidate-contained config file, but Alpha.5 admits it only when it matches the existing config-authority naming subset (`tsconfig*.json` or `jsconfig.json`);
- any other path resolves to candidate-contained `<path>/tsconfig.json`.

Do not invent an extensionless `<path>.json` fallback: TypeScript's project-reference resolver does not do that. Arbitrary differently named JSON configs remain unsupported in Alpha.5 because the current environment authority does not yet bind their broader config/extends semantics.

No absolute path, parent escape, NUL, backslash ambiguity, URL, package name, or external filesystem target is admitted.

Extra fields on a reference object are preserved as unsupported for strong admission unless explicitly researched and admitted. Do not silently ignore a field that can affect TypeScript build/reference behavior.

### 5.2 Graph descriptor

Introduce a small internal/public-evidence shape, preferably additive to the environment manifest rather than a second standalone persisted authority unless implementation evidence requires otherwise.

Expected stable shape:

```ts
project_references: {
  state: "NONE" | "BOUND" | "UNSUPPORTED";
  graph_sha256?: string;
  configs: Array<{
    path: string;
    sha256: string;
    references: Array<{
      declared_path: string;
      resolved_config_path: string;
      resolved_config_sha256: string;
    }>;
  }>;
}
```

Exact TypeScript naming may differ, but identity semantics may not.

The graph digest must be over deterministic candidate-relative data only. Absolute worktree/state paths and timestamps are excluded.

### 5.3 Traversal

- enumerate candidate TypeScript/JavaScript project configs deterministically;
- parse candidate bytes, not projection-mutated bytes;
- normalize/sort graph entries before hashing;
- enforce a bounded config count and edge count using existing candidate/resource ceilings or a new explicit profile ceiling;
- detect cycles;
- reject duplicate edges after normalization when they make identity ambiguous;
- reject missing or non-file targets;
- preserve exact candidate config SHA-256 values.

Cycle handling is fail-closed for strong admission in Alpha.5. Do not attempt to mimic TypeScript build-mode recovery.

## 6. Resolving-project semantics

Alpha.5 does not turn `resolveProjectForDocument()` into a full TypeScript compiler project-membership engine.

The existing nearest-enclosing-config rule may remain the runtime routing rule for the first slice because it is explicit and already receipt-bound.

However:

- if the selected resolving project participates in an unsupported/unbound project-reference graph, strong environment admission is blocked;
- the environment graph identity must distinguish candidates/config revisions even when the nearest selected config path is unchanged;
- runtime/session reuse must not cross an environment identity that differs because the project-reference graph differs.

A later release may add exact include/files/reference membership resolution if evidence shows the nearest-config rule is insufficient for routing.

## 7. Security and provenance boundaries

Project-reference handling is parsing and path admission, not execution.

Required failures:

- absolute reference path -> unsupported;
- `../` escape after normalization -> unsupported;
- symlink/reference target escaping candidate authority -> unsupported;
- missing referenced config -> unsupported;
- malformed JSON / malformed `references` shape -> unsupported;
- cycles -> unsupported;
- reference to package/external config -> unsupported;
- ambiguous target resolution -> unsupported.

The implementation must never open an arbitrary host path merely because candidate JSON names it.

## 8. Receipt and schema impact

Point semantic receipt schema remains `review-lsp.receipt.v1`.

Diagnostics receipt remains `review-lsp.diagnostics-receipt.v1`.

No operation field changes are required.

Project-reference evidence is bound transitively through `environment_manifest_sha256`. If the environment manifest public shape gains `project_references`, receipt validation must continue to treat the environment hash as authoritative without inventing a stronger semantic claim.

Do not bump receipt schemas only for an additive environment-manifest field unless validation compatibility proves a bump is necessary.

## 9. Public API impact

Expected additive changes only:

- `EnvironmentManifest` exposes project-reference admission evidence;
- optional exported helper/types only if there is a concrete standalone consumer in the repository tests or existing public lifecycle;
- no new semantic-session method;
- no new CLI semantic operation;
- no new MCP semantic tool;
- no new container operation.

Existing hover/definition/references/diagnostics automatically benefit because their environment binding/limitations become stricter and more informative.

Capability advertisement remains unchanged.

## 10. Backward compatibility

Existing candidates without `references` retain the same semantic behavior, except the environment manifest gains deterministic evidence that the reference state is NONE.

Candidates with valid admitted project references may remain VERIFIED if every other environment requirement is satisfied.

Candidates whose project-reference shapes were previously ignored may become PARTIAL/UNSUPPORTED. This is an intentional correctness tightening, not a compatibility regression.

## 11. Implementation phases

### P0 — plan and baseline

- exact baseline `ce2e3b7...`;
- new Alpha.5 worktree/task;
- freeze this plan;
- record Alpha.4 public npm/tag identity;
- no feature code before this phase is frozen.

### P1 — internal graph parser/admission

Create a focused project-reference module or focused helpers in the existing config/environment area.

Implement:

- candidate config enumeration;
- JSON-with-comments parsing consistent with existing environment support;
- supported reference-shape validation;
- contained target resolution;
- deterministic graph construction;
- graph digest;
- bounded traversal;
- cycle/missing/ambiguous failure evidence.

Avoid a generic config framework.

### P2 — environment binding

Bind the graph into `EnvironmentManifest`.

Rules:

- NONE when no admitted config declares references;
- BOUND when the full supported graph is admitted;
- UNSUPPORTED with concrete limitations when any relevant graph edge cannot be admitted;
- strong environment binding cannot remain VERIFIED when project-reference admission is unsupported.

Ensure environment identity changes when graph bytes/edges change.

### P3 — unit and differential acceptance

Unit coverage:

- no references;
- one valid directory reference;
- one valid explicit config reference;
- nested/transitive references;
- deterministic ordering/digest;
- duplicate normalized edge;
- missing target;
- absolute path;
- parent escape;
- malformed object;
- malformed array;
- config parse failure;
- cycle;
- graph byte mutation changes identity.

Acceptance coverage:

- TypeScript 6 project-reference fixture;
- TypeScript 7 project-reference fixture;
- hover/definition/references/diagnostics still operate on the admitted candidate;
- project-reference graph appears in environment evidence;
- unsupported graph prevents strong environment admission;
- source_binding remains VERIFIED when source itself is intact;
- exact-project toolchain evidence remains separate from graph admission;
- candidate/projection tamper gates remain unchanged.

Where practical compare semantic results with an independently started reference engine on the same controlled project-reference fixture. This remains fixture-specific conformance evidence, not universal semantic correctness.

### P4 — independent code review before release exposure

Once source implementation exists:

- run OpenCodeReview on the exact candidate;
- inspect every reviewable entry;
- fix blocking findings;
- create a successor candidate/review after fixes;
- require no unresolved blocking findings before release prep.

Markdown exclusion is not independent semantic review PASS.

### P5 — consumer dogfood

Workbench dogfood is required only if Alpha.5 changes observable provider evidence consumed by current review flows.

Expected dogfood:

- exact built Alpha.5 provider artifact;
- candidate with a real project-reference graph;
- consumer still admits only supported evidence;
- environment/project-reference evidence is not promoted into a stronger claim than Review-LSP provides.

No automatic addition of a new Workbench bundled workflow is required.

### P6 — release closeout

On exact release candidate:

- targeted Alpha.5 unit/acceptance tests;
- typecheck;
- build;
- full `pnpm check`;
- package smoke;
- MCP stdio smoke;
- cache-crash smoke;
- macOS Node 22/24;
- Ubuntu Node 22/24;
- Linux container;
- benchmark;
- independent release review;
- exact tag identity;
- GitHub prerelease;
- npm pack identity;
- publish `review-lsp@0.1.0-alpha.5` under `alpha`;
- do not move `latest`;
- public-registry clean-install A/B smoke.

## 12. Rollback and failure behavior

A project-reference parsing/admission failure must not make semantic execution consult ambient config.

Permitted outcomes:

- fail the preparation/environment operation explicitly; or
- return semantic evidence with environment_binding=PARTIAL and a concrete limitation when the existing lifecycle already permits advisory execution.

Which path is used must match existing environment-admission semantics; do not introduce inconsistent per-operation fallback.

Rollback is release-level: Alpha.4 remains the prior public prerelease and no Alpha.4 historical release document is rewritten.

## 13. Release/documentation updates

Before Alpha.5 publication update:

- `ROADMAP.md`;
- `README.md`;
- `CHANGELOG.md`;
- `docs/status/CURRENT.md`;
- `docs/releases/0.1.0-alpha.5.md`;
- `docs/compatibility/0.1.0-alpha.5.md`.

The wording must state that project-reference support is an admitted candidate-contained subset, not universal TypeScript build-mode/project-graph completeness.

## 14. Deferred after Alpha.5

Still separate decisions:

- exact files/include ownership resolution;
- document/workspace symbols;
- project/workspace diagnostics;
- broader config chains and package-based `extends`;
- richer package exports/imports;
- Windows;
- remote MCP;
- signed receipts;
- additional languages;
- broader provider/dependency support.

## 15. Acceptance sentence

Alpha.5 is complete only when Review-LSP can bind a supported candidate-contained TypeScript project-reference graph into exact environment evidence, fail closed on unsupported graph shapes, preserve all Alpha.4 semantic/provenance guarantees, and pass the full prerelease gate on the exact published candidate.
