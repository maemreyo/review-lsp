# Alpha.6 Master Plan — Exact TypeScript Project Ownership and Semantic Routing

Status: FROZEN FOR IMPLEMENTATION

Baseline: `review-lsp@0.1.0-alpha.5` / `c37163494ef51b3417d2b2b0c51e4fb9f5790bde`

Target prerelease: `0.1.0-alpha.6`

## 1. Purpose

Alpha.5 admitted and bound a candidate-contained TypeScript project-reference graph. It deliberately did not prove which project/config owns any given source document. Runtime routing still uses `resolveProjectForDocument()`, which selects the nearest enclosing `tsconfig.json` or `jsconfig.json` by path proximity.

That is insufficient for exact candidate-bound semantic routing because TypeScript ownership is defined by config membership, not directory proximity. A root project can include a nested file; a nested config can explicitly exclude it; `files` can select a file outside the nearest config's default path assumptions; inherited membership can come from a relative `extends` chain; and multiple admitted configs can overlap.

Alpha.6 closes only that gap.

The release claim is:

> Exact candidate-bound TypeScript project ownership and semantic routing for the admitted `files/include/exclude/extends` subset.

This is not a claim of the full TypeScript project model, arbitrary build mode, package-based config inheritance, or universal monorepo routing.

## 2. Non-goals

Alpha.6 MUST NOT add or broaden:

- package `exports` / `imports` handling;
- broader pnpm/workspace shapes unrelated to ownership;
- package-based or external `extends`;
- arbitrary TypeScript build-mode execution;
- document symbols or workspace symbols;
- project/workspace diagnostics;
- consumer SDK/framework layers;
- multi-language support;
- Windows support;
- remote MCP;
- signed receipts;
- arbitrary lifecycle/build scripts;
- implicit host/editor state as ownership authority.

If implementation work reveals one of these is necessary, Alpha.6 fails closed or records a limitation; it does not silently widen scope.

## 3. Existing authority and invariants

Alpha.6 inherits all Alpha.5 invariants:

- exact Git candidate bytes remain source authority;
- candidate-integrity verification must precede semantic claims;
- project-reference evidence remains candidate-contained and content-addressed;
- unsupported or ambiguous inputs must not become VERIFIED;
- semantic receipts remain provenance/tamper evidence, not proof of semantic correctness;
- runtime reuse must bind every identity that can change an answer;
- no ambient config or untracked filesystem may decide ownership;
- TypeScript 6 and TypeScript 7 exact-engine paths remain independently exercised.

Primary predecessor authority:

- `docs/design-notes/ALPHA5_PROJECT_REFERENCE_MASTER_PLAN.md`

Current implementation seams:

- `src/core/project-references.ts`
- `src/core/environment.ts`
- `src/core/toolchain.ts`
- `src/core/runtime.ts`
- `src/core/session.ts`

## 4. Core semantic decision

### 4.1 Ownership is membership, not proximity

For an admitted candidate document `D`, Alpha.6 evaluates every admitted candidate project config `C` whose ownership rules are supported.

Each config yields one of:

- `OWNS`: exact admitted membership proves `D` belongs to `C`;
- `DOES_NOT_OWN`: exact admitted membership proves `D` does not belong to `C`;
- `UNSUPPORTED`: ownership cannot be evaluated without semantics outside the Alpha.6 subset.

Document routing then yields:

- exactly one `OWNS` -> `RESOLVED` to that config;
- zero `OWNS` with all relevant configs evaluable -> `UNRESOLVED`;
- more than one `OWNS` -> `AMBIGUOUS`;
- any ownership-relevant unsupported condition that prevents a unique proof -> fail closed / PARTIAL with a concrete limitation.

No tie-break by nearest directory, lexical order, reference direction, package location, or config depth is permitted.

### 4.2 ResolvingProject state

Alpha.6 extends the effective routing state to distinguish ambiguity from absence.

Required logical states:

- `RESOLVED`
- `UNRESOLVED`
- `AMBIGUOUS`
- `UNSUPPORTED`

The exact public/type representation may be implemented as a widened `ResolvingProject` union or an equivalent ownership-resolution object, but receipts must preserve the distinction.

For `RESOLVED`, evidence must include at minimum:

- config path;
- config SHA-256;
- project root;
- exact ownership identity/digest sufficient to bind the effective membership rules used to prove ownership.

For `AMBIGUOUS`, evidence must identify all proved owners in deterministic sorted order.

For `UNSUPPORTED`, evidence must state the unsupported construct(s) that blocked exact ownership.

## 5. Admitted project-config set

Alpha.6 parses candidate-contained configs within Review-LSP's admitted config naming surface, but it distinguishes configs that provide inheritance evidence from configs that are routable projects.

The admitted config evidence surface includes the Alpha.5 pattern:

- `tsconfig.json`
- `tsconfig.*.json`
- `jsconfig.json`

A config participates in document-owner selection only when it is a routable project under the frozen subset:

- a conventional `tsconfig.json` or `jsconfig.json`; or
- an admitted explicit config that is the resolved target of an admitted project-reference edge.

A non-conventional config used only as an `extends` base remains bound into the effective ownership evidence of its children but does not independently compete for document ownership. This avoids false ambiguity from files such as `tsconfig.base.json` while preserving exact inherited bytes. Arbitrary standalone `tsconfig.*.json` routing that is neither conventional nor project-referenced is outside the Alpha.6 claim.

Unsupported constructs in an admitted config block strong ownership only when that config is routing-relevant: a routable project, a config participating as a project-reference source, or an admitted relative-`extends` ancestor of one of those configs. An unrelated standalone `tsconfig.*.json` outside the routing claim remains content-addressed evidence, including its limitations, but must not poison ownership for otherwise provable projects.

Every config used for ownership MUST be read via candidate-integrity-verified bytes, not raw mutable filesystem reads.

Config discovery and ownership analysis must be bounded. Reuse the Alpha.5 project-config bound where reasonable; introduce a separate documented bound only if ownership expansion materially changes resource behavior.

## 6. Admitted membership fields

Alpha.6 evaluates only these top-level config fields:

- `files`
- `include`
- `exclude`
- `extends`

Compiler options may affect semantic execution, but they are not independently expanded into the ownership language except where an already-supported property is strictly necessary to interpret this frozen subset.

### 6.1 `files`

Admitted shape:

- absent; or
- array of non-empty candidate-relative POSIX file paths.

Rules:

- absolute paths, URL/scheme-like paths, NUL, backslash ambiguity, candidate-root escape and non-string entries are unsupported;
- paths are resolved relative to the config where the `files` property originates;
- the referenced candidate file must exist as an admitted file;
- duplicate normalized entries are unsupported;
- `files: []` is valid and owns no documents through `files`;
- an explicitly listed file is owned even if it would match an `exclude` pattern; `exclude` filters `include` expansion, not explicit `files`.

### 6.2 `include`

Admitted shape:

- absent; or
- array of non-empty POSIX patterns from the frozen Alpha.6 glob subset.

The initial glob subset is deliberately small:

- path literals;
- `*` within one path segment;
- `?` within one path segment;
- `**` as a complete path segment for recursive matching.

Not admitted in Alpha.6:

- brace expansion;
- extglob;
- negated include patterns;
- character classes unless explicitly added by a reviewed plan correction;
- backslashes;
- absolute patterns;
- URL/scheme-like patterns;
- candidate-root escape.

Patterns are evaluated only against admitted candidate files and are rooted relative to the config where the `include` property originates.

Alpha.6 does not scan the ambient filesystem.

### 6.3 `exclude`

Admitted shape and glob grammar are the same frozen subset as `include`.

Rules:

- `exclude` applies only to membership reached through `include`;
- it does not remove explicit `files` membership;
- patterns are rooted relative to the config where the `exclude` property originates;
- excluded candidate files remain part of the candidate; they are merely not owned by that project through the evaluated include set.

### 6.4 Explicit-membership requirement

To avoid silently reimplementing the full TypeScript default file-discovery model, Alpha.6 strong ownership admission requires an effective `files` and/or `include` rule after supported inheritance is applied.

If neither is present in the effective admitted config, ownership for that config is `UNSUPPORTED` for Alpha.6 routing rather than assuming TypeScript's broader default include behavior.

This keeps the release claim narrow and auditable.

## 7. Relative `extends` chain

Alpha.6 admits only candidate-contained relative `extends` chains.

Admitted:

- a single string `extends` value;
- candidate-relative resolution from the declaring config;
- exact candidate file targets using the existing admitted config naming/path rules;
- bounded acyclic chains.

Unsupported:

- package-based `extends`;
- URL/external paths;
- absolute paths;
- candidate-root escape;
- missing targets;
- malformed config targets;
- cycles;
- ambiguous target resolution.

### 7.1 Effective inheritance

Ownership fields are inherited independently. A child declaration replaces only the same field from its base config; it does not erase a different inherited membership field.

For each of `files`, `include`, and `exclude` independently:

- if the child explicitly declares that field, that field replaces the inherited value for that field;
- otherwise the nearest ancestor declaration for that field is inherited;
- `files` and `include` both contribute membership when both are effective, so inherited `include` + child `files` is a union, and inherited `files` + child `include` is also a union;
- `exclude` filters only the effective `include` contribution; it does not remove explicit `files` membership;
- the base directory for path/pattern resolution remains the directory of the config where that effective field was declared.

This behavior was checked against the TypeScript 6 config parser before implementation: child `files` preserves inherited `include`, child `include` preserves inherited `files`, while a child declaration overrides the same inherited field.

The ownership evidence must retain the declaration origin for every effective field so inherited path bases are auditable.

Alpha.6 must not flatten inherited strings and then incorrectly resolve them relative to the child config.

## 8. Ownership evidence model

Introduce deterministic candidate-bound project-ownership evidence. Naming may vary, but the semantics must include:

- schema/version marker;
- state: `NONE | BOUND | UNSUPPORTED`;
- sorted config evidence;
- each config's exact SHA-256;
- whether each config is a routable project or inheritance-only evidence, and why;
- whether each config is routing-relevant to the admitted ownership graph;
- per-config limitations, including limitations retained as non-blocking evidence for unrelated standalone configs;
- admitted relative `extends` chain with exact config digests;
- effective `files/include/exclude` rule origin and normalized values;
- deterministic membership digest per config;
- deterministic aggregate ownership-model digest.

The evidence MUST be included in `EnvironmentManifest` and therefore transitively bound by `environment_manifest_sha256`.

The aggregate digest must not depend on temporary paths, wall-clock time, map insertion order, or host filesystem enumeration.

## 9. Ownership resolver API

The current synchronous nearest-config function cannot prove ownership because exact evaluation requires verified config bytes and inherited parsing.

Alpha.6 may replace it with an async candidate-bound resolver, for example:

```ts
analyzeProjectOwnership(candidate)
resolveProjectOwner(ownershipEvidence, documentPath)
```

or an equivalent architecture.

The important constraints are:

1. candidate bytes are verified before use;
2. ownership analysis is reusable and deterministic;
3. session queries do not independently reinterpret configs with a second semantics;
4. CLI, MCP, runtime manager and direct `SemanticSession` entry points use the same ownership authority;
5. no legacy nearest-config fallback remains on a path that can produce VERIFIED routing.

## 10. Environment admission behavior

`buildEnvironmentManifest()` must bind ownership evidence in addition to Alpha.5 project-reference evidence.

Strong environment admission is blocked when ownership-relevant config state is malformed, unsupported or ambiguous in a way that can affect queried documents.

Permitted behavior follows existing lifecycle semantics:

- fail an operation explicitly where routing is required before execution; or
- return `environment_binding=PARTIAL` with a concrete limitation where advisory execution is already supported.

It is not permitted to silently route using proximity after ownership analysis fails.

## 11. Semantic routing and receipts

For every hover, definition, references and document-diagnostics query:

1. prove the document is an admitted candidate file;
2. resolve the exact owner from the bound ownership model;
3. acquire/use a runtime bound to that owner;
4. reject reuse if the session's bound owner identity differs;
5. record the proven resolving project in `semantic_toolchain.resolving_project`;
6. record the corresponding `resolving_project_identity`;
7. preserve environment/source binding and all existing target provenance.

A receipt claiming `RESOLVED` must never be produced from nearest-config proximity alone.

For ambiguous ownership, the query must not arbitrarily select one owner. The operation must fail closed or produce only downgraded evidence under an explicitly documented advisory path.

## 12. Runtime/session cache binding

The existing runtime key already binds `resolving_project_identity`. Alpha.6 must preserve and strengthen this invariant.

The resolving-project identity for a resolved project must include enough ownership evidence that two routing decisions cannot share a runtime if:

- config bytes differ;
- effective inherited membership differs;
- ownership rule origin differs in a way that changes semantics;
- project owner differs.

At minimum, bind the exact config path/SHA plus the deterministic ownership membership digest.

Add regression tests proving:

- same candidate + same project owner reuses a runtime;
- same candidate + different project owner does not;
- changed ownership evidence changes runtime key identity even when a nearby config path is unchanged.

## 13. Project references interaction

Alpha.5 project-reference evidence remains separate from Alpha.6 ownership evidence.

A reference edge does not itself prove source ownership.

Examples:

- a solution-style root may reference `packages/a` while `files: []`; it owns no package source merely because it references that project;
- a child project may be referenced and own its source through `include`;
- root and child membership can overlap; overlap is ambiguity unless the admitted ownership model proves only one owner.

Project-reference graph and ownership model must both remain independently inspectable and content-addressed.

## 14. Adversarial fixture matrix

Unit tests must cover at least:

### Basic membership

- explicit `files` owns listed document;
- explicit `files` does not own unlisted sibling;
- `files: []` owns no document;
- `include` literal;
- `include` `*`;
- `include` `?`;
- `include` recursive `**`;
- `exclude` removes an include match;
- `exclude` does not remove explicit `files`.

### Inheritance

- child inherits parent `include`;
- child overrides parent `include`;
- child inherits `exclude`;
- child overrides `exclude`;
- inherited patterns resolve relative to declaration origin, not child;
- multi-level relative extends;
- extends cycle;
- missing extends target;
- package/external extends rejected.

### Monorepo routing

- nested config where nearest config does not own the document but root does;
- root config covers child directory while child excludes document;
- root and child both own same document -> ambiguous;
- two sibling configs explicitly list the same shared document -> ambiguous;
- referenced project owns its source independently of reference edge;
- solution root `files: []` plus references does not steal child ownership;
- excluded document resolves UNRESOLVED when no other project owns it;
- explicit `files` may own a document outside the config's immediate directory if the candidate-relative normalized path is admitted.

### Invalid/adversarial paths

- absolute file/pattern;
- root escape;
- backslash ambiguity;
- NUL;
- duplicate normalized file entries;
- unsupported glob grammar;
- malformed array/non-string values;
- candidate config tamper after preparation must fail candidate integrity rather than silently reparse changed bytes.

## 15. TS6 / TS7 acceptance requirements

Both TypeScript 6 and TypeScript 7 exact-engine acceptance must prove routing, not merely environment parsing.

Required acceptance shape:

1. candidate contains at least two projects with distinguishable semantic outcomes;
2. document path is chosen so nearest-config routing would produce the wrong owner in at least one case;
3. Alpha.6 resolves the evidence-proven owner;
4. session/runtime is acquired for that owner;
5. semantic result matches a reference server configured for that owner;
6. receipt records the exact proven config;
7. `environment_binding=VERIFIED` only when all required ownership inputs are admitted.

At least one acceptance case must exercise inherited ownership through relative `extends`.

At least one must prove an ambiguous overlap does not arbitrarily route.

## 16. Consumer-boundary dogfood

Before release, run a real Review-LSP consumer integration through Zamery Workbench/OpenCodeReview where practical.

The dogfood fixture should include project ownership that cannot be correctly inferred from nearest config alone.

The dogfood goal is not to add Workbench-specific policy to Review-LSP. It is to prove that an external consumer can:

- prepare the exact candidate;
- obtain the correct project-specific runtime;
- receive receipts naming the evidence-proven owner;
- preserve candidate A vs live B semantics.

Temporary consumer fixtures are acceptable if the consumer repository is returned clean afterward.

## 17. Implementation phases

### P0 — Freeze

- create this master plan from exact Alpha.5 release baseline;
- verify baseline/tag/main identity;
- inspect current routing/runtime/environment seams;
- commit the frozen authority before implementation.

### P1 — Ownership model

- add candidate-verified config parsing for the frozen fields;
- implement relative extends-chain evaluation;
- implement frozen glob matching;
- produce deterministic per-config and aggregate ownership evidence;
- add exhaustive unit/adversarial tests.

### P2 — Environment binding

- add ownership evidence to `EnvironmentManifest`;
- include it in environment hash;
- ensure unsupported ownership blocks strong admission appropriately;
- preserve Alpha.5 project-reference evidence unchanged.

### P3 — Routing integration

- replace nearest-config routing on semantic paths;
- wire CLI/MCP/runtime/session through one ownership authority;
- widen routing state for ambiguity/unsupported outcomes;
- ensure toolchain selection uses the proven owner.

### P4 — Runtime identity

- bind ownership digest into resolving-project identity;
- verify runtime key separation/reuse properties;
- add session mismatch regressions.

### P5 — Semantic acceptance

- TS6 exact-engine routing cases;
- TS7 exact-engine routing cases;
- inherited ownership case;
- adversarial ambiguous-overlap case;
- existing semantic conformance remains green.

### P6 — Independent review and dogfood

- candidate-bound code review of implementation;
- address all release-blocking findings;
- successor review after material fixes;
- Workbench consumer dogfood if integration seam remains available.

### P7 — Release closeout

On exact release candidate:

- targeted ownership unit tests;
- TS6/TS7 routing acceptance;
- typecheck;
- build;
- full `pnpm check`;
- MCP/package/cache smokes;
- benchmark;
- macOS Node 22/24 compatibility;
- Ubuntu Node 22/24 compatibility;
- Linux container smoke;
- clean-install package smoke;
- independent release-prep review;
- tag `v0.1.0-alpha.6`;
- GitHub prerelease;
- publish npm under `alpha`;
- do not move `latest`;
- public-registry clean-install A/B semantic smoke with exact ownership/routing.

## 18. Documentation updates before publication

Update:

- `README.md`
- `ROADMAP.md`
- `CHANGELOG.md`
- `docs/status/CURRENT.md`
- `docs/releases/0.1.0-alpha.6.md`
- `docs/compatibility/0.1.0-alpha.6.md`

Wording must preserve the narrow claim:

> Exact candidate-bound TypeScript project ownership and semantic routing for the admitted `files/include/exclude/extends` subset.

It must explicitly state that full TypeScript config/build-mode semantics, package-based config inheritance, package exports/imports and broader workspace/package shapes remain outside Alpha.6.

## 19. Deferred after Alpha.6

Candidates for Alpha.7 / beta hardening remain separate:

- broader TypeScript config chains and default file-discovery semantics;
- package-based `extends`;
- package `exports/imports` shapes;
- broader workspace routing and pnpm project shapes;
- richer provenance refinements;
- consumer integration ergonomics;
- representative real-repository compatibility corpus;
- container distribution ergonomics;
- document/workspace symbols;
- project/workspace diagnostics;
- additional language profiles;
- Windows;
- remote MCP;
- signed receipts.

If the real-repository corpus after Alpha.6 does not expose a release-blocking architectural gap, Alpha.7 may remain small or be skipped in favor of beta evidence/ergonomics work.

## 20. Acceptance sentence

Alpha.6 is complete only when Review-LSP can prove, from exact candidate-bound `files/include/exclude/relative-extends` evidence, which admitted TypeScript project uniquely owns a queried document; route semantic execution and runtime reuse to that exact owner; refuse or downgrade ambiguous/unsupported ownership rather than guessing; record the proven owner in receipts; preserve all Alpha.5 provenance guarantees; and pass the full prerelease gate on the exact published candidate under both TypeScript 6 and TypeScript 7 acceptance.
