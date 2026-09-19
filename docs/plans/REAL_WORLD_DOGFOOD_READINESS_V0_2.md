# Review-LSP Real-World Dogfood Readiness Plan v0.2

Status: **FROZEN FOR IMPLEMENTATION — architecture review incorporated; no source implementation started at freeze commit**

Date: 2026-09-19

Scope: Review-LSP standalone core plus the reference OpenCodeReview/Zamery Workbench consumer integration.

This plan is derived from the first real-repository dogfood against `zamery-workbench`. It is intentionally focused on the gaps that prevented the useful standalone result from becoming a low-friction, formally admitted daily-review capability.

## 1. Goal

Move Review-LSP from:

> exact-candidate semantics proven in a standalone alpha

to:

> a daily AI code-review capability that can cheaply answer concrete semantic questions about the exact review candidate and, when its full semantic environment is admitted, provide evidence OpenCodeReview can accept directly.

The target workflow is:

```text
OpenCodeReview captures exact candidate
        |
        v
one Review-LSP candidate/runtime binding
        |
        +--> hover
        +--> definition
        +--> later: references / diagnostics / symbols
        |
        v
candidate + dependency + profile + request + result provenance
        |
        v
OpenCodeReview admission receipt
```

Review-LSP remains consumer-neutral. Workbench/OpenCodeReview owns release wiring, review lifecycle and admission policy.

## 2. Dogfood evidence and problem statement

Real dogfood reviewed historical commit:

```text
candidate: 9ab5944c61da69798d50257091012dd3bd7bd423
live HEAD at evaluation: 65aa30ddbb59c8ee9f6626f7aa2762f80dcf6248
```

The exercise proved the main value proposition:

- candidate A contained `stat` at a coordinate where live B contained `rm`;
- Review-LSP returned candidate-A semantics;
- the Review-LSP document SHA-256 exactly matched the independently retained OpenCodeReview candidate document;
- useful cross-file type information was available without manually traversing declarations.

It exposed three direct dogfood blockers plus two additional semantic-environment gaps found during follow-up investigation.

### G1 — dependency-bearing repositories remain PARTIAL

The target is a normal pnpm TypeScript monorepo. Review-LSP currently marks any project declaring package dependencies as:

```text
environment_binding=PARTIAL
candidate declares package dependencies but no dependency snapshot is admitted
```

The query may still be useful as advisory information, but the OpenCodeReview adapter correctly refuses to admit it as exact-candidate semantic evidence.

### G2 — the daily release does not wire the provider

The OpenCodeReview source already supports external Review-LSP, but the shipped daily bundle config contains only the OCR binary identity. Therefore:

```text
candidate_lsp.state=UNCONFIGURED
```

A workspace reload cannot fix this by editing a mutable config because Workbench intentionally serves a frozen release/bundle snapshot for the active generation.

### G3 — candidate preparation is too expensive for per-query use

Dogfood cold `prepare` was approximately 50.4 seconds.

Inspection found that `rawEntries()` currently launches two Git subprocesses for every blob:

1. `git cat-file -s <oid>`
2. `git cat-file blob <oid>`

For the dogfood candidate:

```text
tracked entries: 582
tracked bytes:   6,433,972
```

Direct measurements on the same repository showed:

```text
git ls-tree -rz -r --full-tree        ~0.09s
git ls-tree -rz -r -l --full-tree     ~0.08s
git cat-file --batch for all 582      ~0.11s
git cat-file --batch-check for all    ~0.07s
```

This makes process-per-blob overhead the primary optimization target before introducing more elaborate caching.

The current OpenCodeReview adapter also creates a unique Review-LSP state directory, prepares, queries once, closes and removes that state for every hover request. That is concurrency-safe, but guarantees that candidate and future dependency preparation cannot be amortized across a review.

### G4 — semantic toolchain is reproducible but not necessarily project-aligned

The dogfood candidate declares `typescript@7.0.2`, while the current Review-LSP alpha profile is content-addressed around `typescript@6.0.3` plus `typescript-language-server`.

That is reproducible, but reproducibility alone does not prove that the semantic engine matches the candidate project's intended TypeScript generation. TypeScript 7 is especially important because it ships a native LSP path (`tsc --lsp --stdio`) rather than being merely another `tsserver` package version.

The mismatch is structural, not cosmetic: the observed TypeScript 7.0.2 package does not provide `lib/tsserver.js`, while the current `createTypeScriptProfile()` requires that file and hard-fails `PROFILE_INVALID` without it. The native TypeScript 7 executable successfully exposes LSP over stdio.

Therefore v0.2 must explicitly bind **semantic toolchain alignment**, not only semantic toolchain identity. A dependency snapshot must not cause `environment_binding=VERIFIED` to imply project-toolchain equivalence when the actual language-service generation differs.

### G5 — dependency graph completeness does not imply semantic entry-point completeness

The dogfood candidate contains workspace packages whose `package.json` declares generated entry points such as `./dist/index.d.ts`, while those `dist/` files are not Git candidate material. The candidate has no `paths`/project-reference mapping that would make TypeScript resolve those packages directly to source.

At the reviewed commit, examples include `@zamery/browser-provider`, `@zamery/pi-browser`, and `@zamery/browser-firefox`: their package manifests declare `dist` type/export targets, but those targets are absent from the Git candidate. A pnpm workspace link can therefore be structurally valid while TypeScript semantic resolution for imports through the package entry point is incomplete.

This failure mode would allow a superficially complete dependency snapshot to produce silent semantic degradation unless projection completeness is independently checked.

## 3. Investigation spikes

### 3.1 pnpm dependency projection spike

The historical candidate declares `pnpm@10.20.0`, workspaces, a lockfile and a patched dependency.

A source-only copy of the exact historical candidate was installed using:

```text
pnpm install
  --offline
  --frozen-lockfile
  --ignore-scripts
  --package-import-method=<method>
```

No network is permitted by `--offline`; no package lifecycle script is permitted by `--ignore-scripts`; lockfile drift is refused by `--frozen-lockfile`.

Measured on the target Mac:

| import method | real time | node_modules logical size | symlinks | symlinks escaping projection |
| --- | ---: | ---: | ---: | ---: |
| `copy` | 129.26s | 503M | 1486 | 0 |
| `clone` | 6.15s | 480M | 1486 | 0 |

The `clone` result is a useful feasibility result for APFS copy-on-write, but it is not by itself sufficient evidence for a VERIFIED dependency snapshot. The implementation must still bind exact dependency inputs and output state, reject unsupported ambient inputs, and verify projection boundaries.

### 3.2 Existing persistent primitive

Review-LSP already has:

```text
review-lsp serve <repo> <commit>
```

which prepares one candidate, creates one `SemanticSession`, starts one language server and exposes candidate-bound MCP tools for multiple queries.

Therefore v0.2 should not invent a second generic daemon. The missing piece is a consumer-owned lifecycle/cache contract that reuses an exact candidate/session safely across a review.

### 3.3 TypeScript toolchain routing investigation

The current profile explicitly points `typescript-language-server` at Review-LSP's bundled/pinned TypeScript root. The evaluated project, however, declares TypeScript 7.0.2.

Current upstream behavior makes this a real architectural boundary rather than a version-number detail:

- `typescript-language-server` is a wrapper around the legacy TypeScript/tsserver model and supports an explicit `tsserver.path`;
- TypeScript 7 has a native LSP server, launched through the TypeScript executable with `--lsp --stdio`;
- upstream documentation/issues explicitly warn that silently falling back to another TypeScript version makes language features not reflect the workspace TypeScript.

The v0.2 TypeScript profile therefore needs provider routing by admitted project toolchain generation instead of assuming one fixed semantic engine is project-equivalent for every candidate.

## 4. Architecture decisions

These are proposed decisions to freeze before implementation.

### D1 — keep source candidate and semantic execution projection separate

Do **not** copy or link `node_modules` into `candidate.source_root`.

The source candidate is evidence authority and currently has a strict path-set/hash invariant. Mixing generated dependency state into that tree would weaken a useful invariant and make source identity harder to reason about.

Instead introduce:

```text
CandidateDescriptor
  source_root                 exact Git bytes

DependencySnapshotDescriptor
  dependency_root             admitted package-manager projection

SemanticExecutionProjection
  execution_root              source + admitted dependency view
```

Semantic execution uses `execution_root`, while every queried source document must still hash back to the exact candidate entry.

### D2 — dependency snapshot is content-addressed and reusable

Dependency state is expensive and is mostly a function of dependency inputs rather than the individual semantic question.

Snapshot identity must bind at least:

- package-manager ecosystem and exact version;
- platform and architecture;
- lockfile digest;
- workspace manifest digests;
- root/package manifest digests relevant to resolution;
- workspace definition;
- package-manager config admitted by the profile;
- referenced patches;
- selected install policy;
- script policy;
- network policy.

A snapshot is reused only when this semantic identity matches exactly.

The snapshot content identity is derived from admitted semantic inputs plus the published dependency tree manifest. `materialization_method` (`clone`, `copy`, or a future equivalent) is operational metadata, **not** part of `snapshot_id` when it produces the same admitted tree. Absolute cache paths and timestamps are likewise excluded from content identity.

### D3 — no ambient dependency authority; acquisition is a first-class phase

An existing live `node_modules` or mutable `~/.pnpm-store` may be used only as an **acquisition source**, never as VERIFIED semantic authority merely because it exists.

The dependency lifecycle is explicitly split:

```text
acquire candidate dependency artifacts
        |
        v
publish content-addressed dependency snapshot
        |
        v
seal + verify snapshot
        |
        v
semantic execution may lease it
```

Acquisition may satisfy a historical candidate whose required package versions are no longer present in the ambient store. The acquired bytes are verified against the exact admitted lock/config/integrity inputs, then cloned/copied into Review-LSP-owned snapshot state and independently manifested before they can become `BOUND`.

The mutable package-manager store is therefore transport/cache input, not evidence authority.

### D4 — no network during semantic execution

Semantic queries never download dependencies.

A separate explicit acquisition operation may use network access when policy permits, but it is never triggered implicitly by `hover`, `definition`, session start, or OpenCodeReview admission. Network acquisition must be observable, bounded, and tied to the candidate dependency inputs it is satisfying.

If acquisition is unavailable or fails, semantic execution fails closed/actionably rather than silently consulting ambient dependency state.

### D5 — no install scripts; projection completeness is independently gated

The v0.2 pnpm provider uses `--ignore-scripts`.

If a dependency requires generated artifacts from lifecycle scripts for correct semantic resolution, that environment cannot be promoted to VERIFIED under this profile. It must return PARTIAL/UNSUPPORTED with a concrete limitation.

This does **not** solve workspace-package build outputs. A workspace package can be linked correctly while its declared semantic entry point is absent because `dist/` or generated declarations are not Git candidate material and are not produced by `pnpm install`.

Before a projection can become VERIFIED, Review-LSP must run an **entry-point resolvability gate** over workspace packages reachable by the candidate project. At minimum it must validate the TypeScript-relevant declared targets selected by the active module-resolution mode (`types`/`typings`, applicable `exports` conditions, and JS/main fallback where relevant). Any selected target that is absent from the projection produces a concrete limitation and forces PARTIAL/UNSUPPORTED.

Review-LSP v0.2 does not execute package `build` scripts through a shell to repair this gap automatically. A missing semantic entry point may become supportable only through P3's constrained **derived workspace semantic artifact** provider, which recognizes a narrow TypeScript build recipe and invokes the already-admitted compiler directly under the required isolation profile. Arbitrary/custom build pipelines remain PARTIAL/UNSUPPORTED.

### D6 — never hardlink an admitted dependency snapshot to mutable ambient state

Allowed first implementation:

- copy-on-write clone when supported and verified;
- copy fallback.

Do not use hardlinks for an admitted immutable snapshot because later mutation of either inode alias could invalidate the evidence boundary.

The chosen materialization method is recorded for diagnostics/performance only. If clone and copy publish byte/symlink-identical admitted trees, they resolve to the same semantic snapshot identity.

### D7 — Workbench ships Review-LSP as release-owned capability

Do not configure a developer checkout path in the daily bundle.

The Workbench release should contain an exact Review-LSP package/provider artifact, authenticate it in release authority, and derive the OpenCodeReview provider path/digest from that immutable release.

Older releases that do not contain Review-LSP must continue to expose OpenCodeReview without external semantic admission, preserving rollback compatibility.

### D8 — review lifecycle owns semantic-session reuse

OpenCodeReview should manage a candidate-bound Review-LSP runtime for a review/candidate, instead of invoking `prepare -> query -> close` for every semantic question.

The generic Review-LSP core owns candidate/session correctness. The consumer owns:

- when to start;
- concurrent request coordination;
- idle TTL;
- finalization/cancel cleanup;
- recovery after process death.

### D9 — PARTIAL remains advisory

No performance or UX improvement may weaken the existing rule:

```text
environment_binding != VERIFIED
=> do not admit as strong exact-candidate semantic evidence
```

### D10 — semantic-toolchain alignment is per resolving project, not per repository

The environment/profile model must distinguish at least:

```text
provider identity         which Review-LSP implementation executed
resolving project         which tsconfig/jsconfig/project owns the queried document
project toolchain         which TypeScript generation/version that project resolves
semantic engine           which TypeScript engine actually answered the query
toolchain alignment       EXACT_PROJECT | COMPATIBILITY_PROFILE | MISMATCH | UNKNOWN
```

For strong daily-review admission, the default target is `EXACT_PROJECT` for the **resolving project that owns the queried document** whenever its toolchain is admissible. A monorepo may legitimately require different semantic runtimes for different project roots.

The current dogfood candidate itself declares TypeScript 7.0.2 at the workspace root. Its lockfile also contains TypeScript 5.9.3, but that 5.9.3 instance is an internal dependency of `@vtsls/language-service`; it is not evidence that this candidate already has a second workspace project declaring TypeScript 5.9.3. The per-project design is therefore an architectural requirement, not a claim about that specific candidate.

Initial routing proposal:

- TypeScript <=6 resolving projects: pinned `typescript-language-server` wrapper may use the exact admitted project TypeScript/tsserver from the dependency snapshot when compatible;
- TypeScript 7 resolving projects: use the admitted native TypeScript LSP (`tsc --lsp --stdio`) rather than silently answering with Review-LSP's bundled TypeScript 6 engine;
- if the exact project semantic engine cannot be safely admitted, return PARTIAL/UNSUPPORTED or an explicitly labeled compatibility-profile result; do not call it project-aligned VERIFIED evidence.

The exact compatibility table and project-owner discovery rules are implementation/research deliverables, not assumptions frozen by this plan.

### D11 — executing a candidate-selected semantic engine is a separate trust decision

Exact-project alignment can require executing bytes selected by candidate dependency metadata: `tsserver.js` for legacy TypeScript or a native TypeScript 7 binary. Registry/lockfile integrity proves **which bytes** were acquired; it does not prove those bytes are safe to execute.

Therefore candidate-selected semantic engines must pass a distinct artifact-admission and execution-isolation gate:

- bind package/version/integrity and exact executable/module tree digest;
- disable TypeScript plugin loading (`plugins: []` or the native equivalent) and automatic package acquisition;
- expose only the minimal environment/filesystem needed by the admitted projection;
- no network during execution;
- require an **enforced sandbox/container profile** before candidate-selected engine output can qualify as strong `EXACT_PROJECT` review evidence for untrusted candidates;
- if only `TRUSTED_LOCAL` execution is available, preserve the explicit trust ceiling and do not silently claim hostile-candidate isolation.

This is intentionally separate from D5: refusing package lifecycle scripts does not by itself make execution of a candidate-selected compiler/language-server artifact safe.

### D12 — semantic conformance differential is a required release gate

Identity/provenance can prove **what environment answered**, but not that the answer is semantically correct. v0.2 therefore requires differential semantic conformance tests against a trusted reference environment built from the same controlled fixture/candidate inputs.

The reference environment must be **independent of P3C**. For controlled fixtures it is produced using the project's ordinary reference workflow (for example normal `pnpm install` + the project's normal `pnpm build`, including its normal scripts where the fixture requires them) outside Review-LSP's evidence boundary. P3C output must never be copied, reused, or used to generate the reference oracle.

For selected hover/definition cases, run the same request in:

```text
A. Review-LSP admitted projection
B. reference workspace/environment with required workspace outputs present
```

Canonicalize only transport/path noise, then compare the semantic payload and bound definition target identities. Any unexplained divergence on a result claiming VERIFIED + EXACT_PROJECT is a release-gate failure.

This is a conformance oracle for the exercised fixtures/queries, **not** a claim that LSP answers are universally correct or proof that reviewed code is correct. It also does **not** replace P3C's compiler-outcome gate: a shared compile defect can affect both environments and produce zero differential, so exit status/error diagnostics are independently mandatory.

## 5. Implementation roadmap

## P0 — Freeze dogfood baseline and acceptance envelope

Repository: both.

Tasks:

1. Preserve the first dogfood report and exact candidate identities.
2. Add a benchmark fixture/profile matching a realistic TypeScript monorepo shape.
3. Record current:
   - cold candidate prepare;
   - warm candidate prepare;
   - dependency projection cold/warm;
   - semantic session start;
   - hover;
   - definition.
4. Define evidence fields that must survive all later optimization.

Exit:

- baseline is reproducible;
- no implementation change can claim improvement without candidate/evidence parity.

## P1 — Fast candidate ingestion

Repository: Review-LSP.

Replace process-per-blob enumeration with bounded batch Git plumbing.

Preferred design:

1. one `git ls-tree -rz -r -l --full-tree <commit>` for path/mode/type/OID/**tree-declared size**;
2. one long-lived `git cat-file --batch` or `--batch-command` stream for required blob bytes;
3. for every blob, cross-check three separately observed values: `ls-tree -l` declared size, batch header size, and actual payload byte length; a mismatch is an integrity failure;
4. retain NUL-safe path parsing and exact byte framing;
5. preserve all current rejection/resource rules:
   - submodules;
   - unsupported modes;
   - case collisions;
   - path traversal;
   - symlink escape/cycles/missing targets;
   - unresolved LFS pointers;
   - per-file/total limits;
   - object/byte mismatch.

Additional work:

- add compact machine output for `prepare` so a consumer need not receive the full entries manifest over stdout;
- check an already-retained candidate before re-reading every blob where a safe repository/commit/tree lookup can prove the same content-addressed candidate should exist;
- still verify retained candidate integrity before semantic use.

Tests:

- unusual UTF-8 paths and NUL-delimited records;
- executable/symlink entries;
- object-size mismatch;
- malformed batch response;
- premature Git exit;
- resource limits;
- integrity parity against current implementation.

Acceptance:

- exact candidate descriptor/manifest semantics unchanged;
- no size/integrity check is reduced to comparing two fields derived from the same parsed value; `ls-tree -l`, batch header, and received payload length must agree;
- on the dogfood candidate, cold prepare improves materially from ~50.4s;
- target engineering gate: <=5s on the observed target Mac, unless profiling identifies a new integrity-bound cost that should not be weakened;
- repeated use of an existing candidate is cheaper than cold reconstruction.

## P2 — Generic dependency snapshot contract

Repository: Review-LSP.

Add a consumer-neutral descriptor, for example:

```text
review-lsp.dependency-snapshot.v1

snapshot_id
ecosystem
package_manager
package_manager_version
package_manager_identity
platform
arch
input_manifest[]
lockfile_binding
workspace_binding
patch_binding[]
config_binding[]
network_policy
script_policy
tree_manifest_sha256
dependency_root
materialization_method   # operational metadata; excluded from snapshot content identity
created_at               # metadata; excluded from snapshot content identity
```

Extend environment evidence:

```text
dependency_snapshot:
  state: NONE | BOUND | MISSING | UNSUPPORTED
  snapshot_id?
  sha256?
```

The exact schema may evolve during implementation, but the state semantics may not be weakened.

First provider: pnpm only.

### P2A — explicit dependency acquisition

Acquisition is a first-class operation, not an implicit side effect of a semantic query.

- derive the exact required artifacts from candidate manifests/lockfile/workspace/patch/config inputs;
- prefer already-available package-manager cache content when it satisfies those exact inputs;
- when policy explicitly permits, fetch missing historical artifacts into an acquisition cache using the pinned package manager;
- verify registry/package integrity and candidate patch/config bindings before publication;
- run no lifecycle scripts;
- never treat the mutable acquisition cache itself as `BOUND` evidence;
- return an actionable `ACQUISITION_REQUIRED`/equivalent state when semantic execution lacks required artifacts and acquisition was not authorized.

Historical-commit dogfood is an acceptance case: lack of an old version in the current `~/.pnpm-store` must not be modeled as a permanent semantic limitation when the exact artifact can be explicitly acquired and verified.

### P2B — publish and admit dependency snapshot

Clone/copy the acquired dependency graph into Review-LSP-owned state, build the dependency tree manifest, apply the immutable seal, and only then publish the content-addressed snapshot as eligible for `BOUND` admission.

pnpm inputs to admit:

- `packageManager` declaration / selected exact pnpm version;
- `pnpm-lock.yaml`;
- `pnpm-workspace.yaml`;
- all workspace `package.json` files relevant to the lockfile/importers;
- root and admitted workspace package manifests;
- development dependencies required by the semantic/type environment are included; the initial pnpm semantic snapshot is **not** a `--prod` install. This is required for cases such as workspace packages whose tsconfig inherits `types: ["node"]` and resolves `@types/node` from the workspace/root dev dependency graph;
- `.npmrc` only through an explicit safe-key policy;
- dependency patch files referenced by pnpm configuration;
- platform/arch;
- package-manager store identity needed to prove the projection source;
- project semantic-toolchain declaration/resolution, including the exact TypeScript package/version when present.

The dependency provider must expose enough information for the semantic profile router to select the candidate project's admitted TypeScript generation. Dependency admission and semantic-toolchain admission are related but separate claims.

Explicit unsupported/partial cases include:

- executable package-manager hooks/config;
- dependency paths outside candidate authority;
- unresolved external workspace/file dependencies;
- install state requiring lifecycle-generated semantic artifacts;
- unsupported lockfile/package-manager version;
- required dependency artifact neither present in admitted acquisition cache nor explicitly acquirable under current policy;
- missing workspace semantic entry point or generated declaration required by the resolving project.

Security:

- isolated HOME/config;
- no user-global npmrc authority;
- semantic snapshot publication/execution offline;
- any network use confined to explicit acquisition and never inherited by semantic execution;
- frozen lockfile;
- include the admitted development dependency graph needed for TypeScript/module/type resolution; do not use `--prod` for the initial semantic snapshot profile;
- ignore scripts;
- no hardlinked admitted snapshot;
- output tree containment verification.

Acceptance:

- a dependency-bearing pnpm fixture reaches VERIFIED only when all required inputs are admitted;
- a historical fixture with a deliberately absent local-store package can be explicitly acquired, integrity-verified, published, then used without network during semantic execution;
- project TypeScript version/toolchain identity is extracted from the admitted dependency state rather than from ambient `node_modules`;
- a linked workspace package whose selected `types`/`exports` semantic target is missing cannot reach VERIFIED;
- deleting/tampering a bound dependency snapshot invalidates it;
- missing local store data never silently enables network;
- lifecycle scripts are proven not to execute;
- a fixture whose workspace package obtains required ambient types from root devDependencies resolves them in the admitted semantic snapshot, proving the provider did not accidentally project a production-only dependency graph.

## P3 — Semantic execution projection

Repository: Review-LSP.

Introduce an execution view without mutating source authority.

Possible shape:

```text
state/
  candidates/<candidate_id>/source/
  dependencies/<snapshot_id>/...
  projections/<projection_id>/
```

Projection identity binds:

- candidate ID/source manifest;
- dependency snapshot ID;
- zero or more derived workspace semantic artifact snapshot IDs/manifests;
- resolving-project identity;
- semantic profile/engine identity;
- projection implementation/version;
- isolation mode.

Requirements:

1. LSP `cwd`, `rootUri`, and workspace folder point at the projection.
2. Candidate source paths in the projection must map byte-for-byte to candidate entries.
3. Queried document receipt remains bound to candidate SHA, not merely projection path.
4. Definition/result URIs gain classifications:
   - `CANDIDATE_SOURCE`;
   - `DEPENDENCY_SNAPSHOT`;
   - `DERIVED_WORKSPACE_ARTIFACT`;
   - `TOOLCHAIN`;
   - `UNBOUND`.
5. URI classification must normalize both lexical projection paths and resolved realpaths. Symlinked pnpm/workspace paths are classified only when both the link provenance and final realpath stay inside admitted roots; an escape or ambiguous mapping is `UNBOUND`.
6. Any UNBOUND semantically relevant result downgrades evidence.
7. Environment manifest binds dependency snapshot, all admitted derived workspace artifact snapshots, resolving-project identity, and projection identity.
8. Resolve the owning tsconfig/jsconfig/project for each queried document before selecting the semantic engine; cache/session keys include that resolving-project identity.
9. The semantic profile router selects and binds the actual project-aligned engine:
   - legacy TypeScript/tsserver path when an admitted <=6 project toolchain is compatible;
   - native TypeScript 7 LSP (`tsc --lsp --stdio`) for admitted TypeScript 7 projects;
   - explicit PARTIAL/UNSUPPORTED/compatibility-profile state when exact alignment is unavailable.
10. Candidate-selected engine artifacts must satisfy D11's artifact-admission/isolation requirements before `EXACT_PROJECT` can be strong evidence. The implementation must define a platform-specific enforced execution profile (sandbox or container). If no such profile can execute the exact admitted engine for the target platform, the result remains below strong `EXACT_PROJECT` admission instead of falling back silently to `TRUSTED_LOCAL`.
11. Receipts/environment evidence record `resolving_project`, `project_toolchain`, `semantic_engine`, and `toolchain_alignment`; `VERIFIED` alone must not be interpreted as project-aligned unless the alignment field says so.
12. Linux container mode gets the equivalent read-only source/dependency/derived-artifact projection with no network.

### P3C — constrained derived workspace semantic artifacts

When the entry-point gate finds a missing workspace semantic target, Review-LSP may derive it only under a narrow provider contract; it must not execute arbitrary package scripts.

First supported derivation shape:

- workspace package build recipe is recognized by a strict parser as a plain TypeScript project build (`tsc -p <config>` or an explicitly equivalent allowlisted form); the recipe is evidence/input, not a shell command to execute;
- the selected project config must be candidate-bound and contained within the workspace package/project authority; its tsconfig/extends chain is fully admitted;
- required workspace packages are derived in the admitted workspace dependency order; unsupported cycles/custom generation fail closed;
- the package's resolving dependencies are already in the admitted dependency snapshot;
- the exact project TypeScript engine is already admitted under D10/D11;
- execution invokes the **absolute admitted compiler artifact**, never `tsc` resolved from PATH or a workspace `.bin` shim;
- compiler execution happens in the enforced isolation profile with no network/plugins/automatic acquisition;
- output is containment-bound to a dedicated staging root, never to `candidate.source_root` or the sealed dependency snapshot;
- no shell, prebuild/postbuild, arbitrary executable, custom transformer, or package lifecycle hook is invoked.

Publish the outputs as a separate content-addressed descriptor binding at least:

```text
derived_snapshot_id
candidate/package identity
tsconfig + extends digests
resolving-project identity
compiler/semantic-engine identity
fixed compiler argv/recipe
input dependency snapshot id
compiler exit status
compiler diagnostic error count
compiler stdout/stderr digest or equivalent bounded diagnostic transcript identity
output tree manifest sha256
```

The semantic projection may expose these bytes at the package's declared `dist`/types locations, but receipts classify them as `DERIVED_WORKSPACE_ARTIFACT`, never as Git candidate source.

Compiler outcome is a hard admission gate. A derived snapshot may be retained as advisory/debug evidence after a failed compile, but it may support `VERIFIED + EXACT_PROJECT` only when:

```text
compiler exit status == 0
compiler diagnostic error count == 0
```

A non-zero exit, any error diagnostic, crash, timeout, or inability to determine a trustworthy error count forces the derivation to FAILED/PARTIAL and prevents its outputs from satisfying the strong entry-point completeness gate, even if `.d.ts` files were emitted. Do not rewrite the project recipe with `--noEmitOnError`; preserve the admitted recipe/toolchain semantics and bind the observed compile outcome explicitly.

After a zero-error derivation, rerun the entry-point resolvability gate. If the required target is still absent, the environment remains PARTIAL/UNSUPPORTED.

For the original dogfood repo, the observed affected public workspace packages (`@zamery/browser-provider`, `@zamery/pi-browser`, `@zamery/browser-firefox`) declare `types: ./dist/index.d.ts`, use `tsc -p tsconfig.json`, and inherit `declaration: true`; they are therefore concrete acceptance candidates for this narrow provider, not proof that arbitrary monorepo builds are supported.

Acceptance:

- project-local type query on dependency-bearing fixture: VERIFIED;
- TypeScript <=6 fixture uses the exact admitted resolving-project TypeScript engine and reports `EXACT_PROJECT` under the required isolation profile;
- TypeScript 7 fixture uses the admitted native TypeScript LSP and reports `EXACT_PROJECT` under the required isolation profile;
- target-platform isolation feasibility is explicitly proven; unsupported platform/isolation combinations fail closed rather than weakening the trust claim;
- a multi-project monorepo fixture with different project-local TypeScript versions routes each queried document to the owning project's engine;
- an intentionally mismatched provider/toolchain case does not masquerade as project-aligned VERIFIED evidence;
- missing workspace type entry point without an admitted derivation remains PARTIAL;
- a supported plain-`tsc -p` workspace package can produce a sealed derived artifact snapshot and then pass the entry-point gate only when compiler exit status and diagnostic error count are both zero;
- a fixture with `noEmitOnError` unset and an intentional TypeScript error may emit declarations, but those outputs cannot support VERIFIED/EXACT_PROJECT;
- derived declarations are receipt-bound as `DERIVED_WORKSPACE_ARTIFACT` and never misclassified as candidate source;
- custom/arbitrary workspace build script is not executed and remains PARTIAL/UNSUPPORTED;
- dependency type/definition resolution into admitted node_modules: VERIFIED + DEPENDENCY_SNAPSHOT binding;
- pnpm/workspace symlink definition URIs classify correctly after realpath normalization;
- symlink escape or URI outside all admitted roots: PARTIAL;
- source document SHA still equals the original Git candidate SHA.

## P4 — Candidate, dependency and semantic-session reuse

Repositories: Review-LSP core primitives + OpenCodeReview lifecycle integration.

Do not create a second generic service if the existing `serve`/persistent `SemanticSession` model is sufficient.

OpenCodeReview target lifecycle:

```text
review SEALED / first semantic query
        |
        v
acquire exact candidate runtime
        |
        +-- candidate cache
        +-- dependency snapshot cache
        +-- one semantic server/session
        |
        +--> query N times
        |
review finalizes/cancels or TTL expires
        |
        v
close session; release leases; GC eligible cached material
```

Correctness requirements:

- cache key includes exact candidate, dependency snapshot, derived workspace artifact snapshots, resolving-project, semantic-engine/profile, projection and isolation identities;
- concurrent requests share lifecycle safely;
- close cannot race an admitted in-flight query;
- process crash makes in-flight result UNKNOWN/failed, never successful by replay assumption;
- dependency snapshots have an explicit lifecycle such as `DRAFT -> SEALED -> LEASED/IDLE -> GC`;
- publication performs the full tree verification once before `SEALED`;
- repeated queries in one live lease do **not** full-rehash the dependency tree;
- after a Review-LSP/consumer process restart, the first acquire of a cached snapshot performs one full re-verification before minting a fresh verified lease; later acquires in that process may reuse that verified lease state while seal/root identity remains unchanged;
- this optimization is valid only within the documented `TRUSTED_LOCAL` threat ceiling; enforced container execution additionally relies on read-only mounts;
- cleanup is idempotent;
- durable admission receipt remains independent of process lifetime;
- bounded disk cache + explicit GC/TTL.

The current per-query UUID namespace can remain as fallback until the managed-session path is proven.

Acceptance:

- four concurrent semantic queries on one review do not prepare four candidates/dependency graphs;
- no shared-close race;
- second and later semantic query does not rebuild or full-rehash dependency state while the verified lease remains valid;
- process restart causes one bounded re-verification before cached snapshot reuse, not one per query;
- process kill/recovery cannot produce a false admission.

## P5 — Release-owned Workbench provider wiring

Repository: Zamery Workbench/OpenCodeReview.

After Review-LSP v0.2/next alpha is published:

1. add an **exact pinned** Review-LSP production dependency to the release-owned OpenCodeReview package or an equivalent dedicated release provider package;
2. make `pnpm deploy --prod` ship the provider in the release tree;
3. add provider identity files to release authority, at minimum:
   - Review-LSP CLI/bundle entrypoint;
   - Review-LSP artifact manifest;
   - any file required to verify whole-provider identity;
4. have daily bundle construction conditionally configure:
   - exact release-owned provider path;
   - expected identity/digest;
5. do not make Review-LSP presence a requirement for the base OpenCodeReview capability in old releases;
6. preserve generation immutability: provider changes arrive by release/promotion/restart, not by mutating an active generation.

Strengthen admission:

- call/validate `artifact-info`, not only the CLI-file SHA;
- surface provider version/artifact ID/profile identity in `code_review_capabilities`;
- bind whole-provider identity into admission receipt.

Acceptance:

```text
code_review_capabilities
  review_lsp.state = CONFIGURED/READY
  provider identity = release-admitted
```

on a freshly promoted release, without developer-path configuration.

Rollback to a pre-Review-LSP release still leaves ordinary OpenCodeReview working.

## P6 — Consumer semantic surface and coordinate safety

Repositories: both, primarily OpenCodeReview.

### Hover

Keep existing strict admission checks:

- exact OCR commit/tree;
- exact candidate document SHA;
- Review-LSP source VERIFIED;
- environment VERIFIED;
- provider identity admitted.

### Definition

Wire the already-existing Review-LSP `definition` operation through the consumer path and persist its provenance/bindings.

The first dogfood did not evaluate definition; v0.2 acceptance must.

### Coordinate guard

The dogfood produced one valid but irrelevant hover after a line-offset mistake. Provenance was correct; reviewer intent was not.

Add an optional consumer-side request guard such as:

```text
expected candidate token / line digest / context digest
```

or return the bound source line/context alongside the semantic answer so the agent can cheaply verify that the requested position corresponds to the intended symbol.

Do not turn this into a heuristic evidence upgrade. A semantically irrelevant but provenance-valid response stays irrelevant.

## P7 — Performance, security and regression gates

Repositories: both.

### Candidate preparation

Realistic benchmark must include hundreds of files, not only the tiny current benchmark.

Record:

- entry count;
- tracked bytes;
- Git enumeration;
- materialization;
- integrity verification;
- total cold prepare;
- warm candidate lookup.

### Dependency snapshot

Record:

- cold materialization;
- warm reuse;
- logical size;
- physical size where measurable;
- file/symlink count;
- escaped symlink count;
- snapshot verification time.

Observed feasibility baseline on the target APFS Mac:

```text
pnpm clone projection ~6.15s
pnpm copy projection  ~129.26s
```

The large delta is a filesystem/materialization capability difference, not a universally portable optimization. Performance gates must therefore be reported separately for:

- clone/reflink-capable local filesystems;
- copy-only local filesystems;
- Linux container/read-only projection paths.

A single-digit cold-snapshot budget is **not** required on copy-only/container paths in v0.2. Those paths get separate measured budgets; the interactive product target applies to warm admitted snapshots and reused sessions.

No release promise is derived solely from these spike measurements.

### Query lifecycle

Record:

- semantic server start;
- first hover;
- warm hover;
- definition;
- concurrent query behavior.

Suggested product target on the target clone-capable Mac:

- warm dependency snapshot + existing candidate: first useful semantic answer should generally fit within a single-digit-second budget;
- subsequent hover/definition should generally be near interactive latency.

For Linux/container or copy-only cold materialization, record a separate cold-path budget and optimize it independently; do not fail a safe implementation merely for missing APFS clone semantics.

These are optimization goals, not excuses to weaken evidence checks.

### Semantic conformance differential

For every supported engine generation and dependency-projection shape used for release acceptance, maintain controlled reference fixtures with required workspace build outputs present. Run the same hover/definition request against:

1. Review-LSP admitted projection;
2. trusted reference workspace/environment.

Compare canonical semantic payloads and definition target identities. A divergence on a result claiming `VERIFIED + EXACT_PROJECT` blocks release until explained and encoded as an explicit compatibility rule or fixed.

Required fixtures include:

- TypeScript <=6 project;
- TypeScript 7 native LSP project;
- negative pnpm workspace package with a missing generated `dist/*.d.ts` entry point, which must refuse VERIFIED;
- positive plain-`tsc -p` workspace package whose derived declarations match the trusted reference build output semantically;
- multi-project monorepo routing case;
- dependency definition reached through pnpm symlinks.

### Negative tests

Required:

- acquisition required because historical artifact is absent from local store;
- stale lockfile;
- unsupported package-manager config;
- script-requiring dependency;
- missing workspace `types`/selected `exports` target;
- custom workspace build recipe that must not be executed;
- derivation recipe trying to select an external config, PATH-shadowed compiler, or escaping output;
- plain-`tsc -p` derivation with `noEmitOnError` unset and an intentional type error that still emits `.d.ts`; compiler exit/error gate must keep it below VERIFIED/EXACT_PROJECT;
- compiler crash/timeout or indeterminate diagnostic error count during derivation;
- derived workspace artifact tampering;
- dependency snapshot tampering;
- projection source mutation;
- escaping dependency symlink and misleading realpath;
- candidate-selected engine artifact/digest mismatch;
- attempt to claim `EXACT_PROJECT` without the required isolation profile;
- wrong resolving-project/toolchain routing;
- process crash during query;
- process crash during cache publication;
- concurrent acquire/release;
- old Workbench release without provider;
- provider digest/artifact mismatch.

## P8 — Release and second real-world dogfood

Sequence:

1. complete Review-LSP P1–P4/P6 core parts;
2. run P7 Review-LSP core performance/security/semantic-conformance gates;
3. independent candidate-bound code review of Review-LSP changes;
4. publish a new prerelease only after those core gates pass;
5. integrate exact release artifact into Workbench;
6. run the P7 consumer/release integration gates;
7. independent review of Workbench integration;
8. build/promote Workbench release;
9. start a fresh runtime generation;
10. run the same real-repository dogfood again.

Second-dogfood minimum acceptance:

```text
provider release-owned:                  YES
code_review_context external LSP:        SUPPORTED
exact historical candidate isolation:    YES
hover:                                    YES
definition:                               YES
source_binding:                           VERIFIED
environment_binding on supported pnpm:   VERIFIED
workspace entry-point completeness:       VERIFIED
derived workspace artifact binding:       VERIFIED where required
P3C compiler exit/error gate:             PASS where derivation required
project semantic toolchain alignment:     EXACT_PROJECT
candidate engine isolation/admission:     VERIFIED
semantic differential conformance:        PASS
OpenCodeReview admission receipt:         YES
provider/artifact identity bound:         YES
dependency snapshot identity bound:       YES
candidate/dependency reuse measured:       YES
no prepare-per-query behavior:             YES
PARTIAL remains non-admissible:            YES
```

The real review should again use a historical candidate whose live HEAD differs, rather than relying only on synthetic fixtures.

## 6. Cross-repository ownership

| Concern | Review-LSP | OpenCodeReview / Workbench |
| --- | --- | --- |
| exact Git candidate | owns | independently cross-checks |
| dependency snapshot contract | owns | consumes evidence |
| dependency acquisition/publish contract | owns generic mechanism | may authorize/trigger acquisition by policy |
| pnpm provider | owns | no duplicated installer |
| workspace entry-point completeness | owns generic gate | consumes result |
| constrained derived workspace semantic artifacts | owns provider + provenance | consumes result; no duplicated build runner |
| semantic projection | owns | no duplicated projection |
| resolving-project/toolchain routing | owns | consumes evidence |
| candidate-engine isolation profile | owns execution proof | admission policy requires appropriate state |
| semantic server/session | owns | lifecycle manager acquires/releases |
| source/environment receipt | owns | independently admits/rejects |
| review candidate authority | no | owns |
| provider release packaging | no | owns |
| active-generation config | no | owns |
| review lifecycle / TTL | generic lease primitive only if required | owns policy |
| provider artifact admission | exposes artifact identity | authenticates release + receipt |
| final review evidence policy | no | owns |

This separation is deliberate. Review-LSP must remain useful to consumers other than Zamery.

## 7. Language-scale implications

Do not generalize by creating a separate product per language.

The intended future shape remains:

```text
Review-LSP Core
  |
  +-- TypeScript profile
  |     +-- pnpm dependency provider
  |     +-- npm/yarn providers later if justified
  |
  +-- Python profile
  |     +-- Python environment/dependency admission
  |
  +-- Go profile
  |     +-- module/cache admission
  |
  +-- Rust profile
        +-- Cargo dependency/toolchain admission
```

The core abstractions introduced by P2/P3 must therefore avoid names/contracts that only make sense for `node_modules`.

However, v0.2 implements and proves TypeScript + pnpm first. Python/Go/Rust work begins only after the generic snapshot/projection boundary survives the TypeScript dogfood.

## 8. Explicit non-goals for this plan

- Automatically provisioning generic live-editor `vtsls`; that is a separate Workbench language-tool concern.
- Treating live editor LSP as review evidence.
- Supporting dirty workspace/index candidates in Review-LSP v0.2.
- Running arbitrary dependency lifecycle scripts to obtain VERIFIED status.
- Downloading packages implicitly during a semantic query.
- Adding multiple languages before the snapshot/projection model is proven.
- Promoting plausible PARTIAL results.
- Turning LSP output into proof of code correctness.

## 9. Implementation order

Recommended execution order after review:

```text
P0 baseline
  |
P1 fast Git ingestion
  |
P2A explicit dependency acquisition
  |
P2B dependency snapshot contract + pnpm publication
  |
P3 semantic projection
  |
P4 reuse/lifecycle
  |
P6 consumer operations/coordinate guard
  |
P7A Review-LSP core performance/security/conformance gates
  |
Review-LSP prerelease
  |
P5 Workbench release-owned wiring
  |
P7B consumer/release integration gates
  |
P8 second real-world dogfood
```

P4 design can be prototyped while P2/P3 are in progress, but it should not freeze a lifecycle API before snapshot/projection identity is known.

## 10. Review questions / decisions to approve

The implementation should start only after these decisions are accepted or amended:

1. **Source candidate stays immutable and dependency-free; execution uses a separate projection.**
2. **First VERIFIED dependency provider is pnpm only.**
3. **Semantic execution uses frozen-lockfile + ignore-scripts + projection entry-point resolvability gates; dependency acquisition is an explicit separate phase and may use network only when policy authorizes it. Ambient `node_modules`/pnpm store is never evidence authority. Missing workspace type entry points may be satisfied only by the constrained admitted-compiler derivation provider; arbitrary package build scripts remain unsupported, and derived outputs may support VERIFIED/EXACT_PROJECT only when compiler exit status is 0 and diagnostic error count is 0.**
4. **Clone-or-copy only; never hardlink admitted dependency snapshots.**
5. **Dependency snapshots are content-addressed/reused with bounded GC; materialization method is metadata, not semantic identity. Publish-time full verification + sealed leases avoid full-tree rehash on every query.**
6. **OpenCodeReview reuses one candidate semantic runtime across concrete questions instead of per-query prepare/close.**
7. **Workbench ships/authenticates Review-LSP as release-owned provider; no developer-path daily config.**
8. **Hover + definition are the v0.2 admitted semantic surface; broader operations follow after this slice is stable.**
9. **Environment PARTIAL remains advisory and cannot satisfy exact-candidate admission.**
10. **Semantic-toolchain alignment is first-class and per resolving project; TypeScript 7 uses its admitted native LSP rather than silently falling back to bundled TypeScript 6.**
11. **Executing a candidate-selected TypeScript engine is a separate trust boundary: exact artifact admission, plugins/automatic acquisition disabled, no network, and enforced sandbox/container required before untrusted candidate engine output can qualify as strong `EXACT_PROJECT` evidence.**
12. **Semantic differential conformance against an independently produced trusted reference workspace is a mandatory release gate for VERIFIED + EXACT_PROJECT hover/definition results. The reference must use the project's ordinary build workflow outside Review-LSP's evidence boundary and must not reuse P3C outputs; this differential gate does not replace P3C's independent zero-exit/zero-error compiler gate.**
13. **Additional languages wait until the generic snapshot/projection architecture is proven by the TypeScript/pnpm path.**

## 11. Definition of done

This program is complete when the second real-repository dogfood can use only the normal OpenCodeReview flow and demonstrate:

- no live-workspace semantic confusion;
- no manual provider configuration;
- no per-query cold candidate preparation;
- dependency-bearing supported TypeScript project reaches VERIFIED through an admitted snapshot;
- historical dependencies can be explicitly acquired without permitting network during semantic execution;
- workspace semantic entry points required by the resolving project are proven present before VERIFIED, with any constrained derived artifacts separately content-addressed and receipt-bound;
- any P3C derivation used for strong evidence has compiler exit status 0 and diagnostic error count 0; emitted declarations from failed/erroring compiles remain advisory only;
- the actual semantic engine is aligned with and bound to the queried document's resolving project and admitted TypeScript generation;
- candidate-selected engine execution satisfies the declared isolation/trust profile;
- controlled semantic differential fixtures match the trusted reference environment for accepted hover/definition cases;
- provider, candidate, document, dependency environment, any derived workspace artifact snapshots, resolving project, semantic toolchain, request and result identities are all carried into durable admission evidence;
- latency is low enough that an AI reviewer can invoke semantics only when useful without creating obvious workflow friction on the warm path, with cold-path budgets reported per filesystem/isolation mode;
- failures remain explicit and never silently downgrade evidence quality.

At that point Review-LSP can reasonably be enabled by default as an **on-demand semantic evidence provider** for supported TypeScript reviews, rather than invoked on every changed line.
