# Changelog

All notable public changes to Review-LSP are recorded here.

The project is currently prerelease software. Until 1.0, minor versions may include breaking changes when the evidence model or public surface needs to evolve.

## Unreleased

## 0.1.0-alpha.5 — 2026-09-23

### Added

- Candidate-contained TypeScript project-reference admission bound into `EnvironmentManifest.project_references` with deterministic graph identity.
- Strict Alpha.5 reference-path handling for admitted directory targets and existing config-authority explicit JSON targets.
- TypeScript 6 and TypeScript 7 exact-engine acceptance coverage for semantic sessions whose environment includes a supported project-reference graph.

### Security / correctness

- Absolute, candidate-escaping, missing/unadmitted, duplicate-normalized, malformed, extra-field, cyclic, and otherwise unsupported project-reference graphs fail closed instead of consulting ambient host config.
- Project-config bytes used for graph admission are read through candidate-integrity verification; parsed bytes and recorded config/reference SHA values share the same verified read boundary.
- Unsupported project-reference admission downgrades strong environment binding without changing point/diagnostics receipt schemas or inventing a stronger semantic claim.
- Project references remain an admitted candidate-contained subset; exact `files`/`include` ownership, broader config chains, package-based config resolution, and universal build-mode completeness are deferred.

### Evidence

- Independent implementation review found one MEDIUM candidate-integrity issue; successor candidate `eeb14530c94d349294730ce45fcd2fe4dc45b268` addressed it and finalized with no new findings.
- Exact-candidate project-reference unit coverage, TypeScript 6/7 acceptance, full release checks, package/MCP/cache-crash smokes, platform matrix, Linux container, benchmark, consumer dogfood, and public-registry clean-install smoke are release gates.

## 0.1.0-alpha.4 — 2026-09-23

### Added

- Candidate-bound `references` with explicit `includeDeclaration` request identity and per-target provenance classification across candidate source, dependency snapshots, derived artifacts, toolchain source, and unbound targets.
- Candidate-bound document `diagnostics` with a separate content-addressed receipt, deterministic ordering, related-information provenance, and explicit completeness semantics.
- Dual deterministic diagnostics transport: TypeScript 6 compatibility profiles use the admitted synchronous tsserver diagnostic command set; TypeScript 7 native engines use `textDocument/diagnostic` when advertised.
- Public diagnostics across `SemanticSession`, CLI, Linux container execution, MCP stdio, and package exports.
- Dynamic diagnostics capability advertisement derived from the initialized semantic engine rather than generic package knowledge.

### Security / correctness

- Reject diagnostics when neither deterministic transport is advertised; do not treat timed `publishDiagnostics` silence as completion.
- Reject widened, unchanged, related-document, malformed-range, malformed-transport, and timeout outcomes where the frozen diagnostics authority cannot prove the requested document result.
- Preserve candidate, document, environment, semantic-toolchain, session, transport, result, and related-information identity in diagnostics receipts.
- Keep diagnostics document-scoped; no diagnostic result is evidence of project-wide build correctness.
- Preserve Linux `CONTAINER_READ_ONLY` isolation for diagnostics without synthetic line/character coordinates.
- Keep Workbench consumer policy outside Review-LSP core; external dogfood admits references/diagnostics only through explicit provider capabilities and exact candidate receipts.

### Evidence

- Independent implementation reviews for references and diagnostics completed with blocking findings repaired through clean successor reviews where required.
- Exact-candidate TypeScript 6/7 differential acceptance, MCP, installed-package, cache-crash, and Linux container diagnostics gates are required PASS before publication.
- Real pinned Review-LSP provider dogfood through Zamery Workbench covers both references and document diagnostics.

## 0.1.0-alpha.3 — 2026-09-22

### Fixed

- Bind candidate-contained local `.tgz` dependencies referenced through pnpm `file:` lockfile entries into dependency input identity and acquisition materialization.
- Fail closed when a local file dependency is missing, escapes candidate authority, is ambiguous, or is not an admitted tarball artifact.
- Preserve snapshot invalidation when local tarball bytes change by including those bytes in `input_set_id`.

### Evidence

- Real Zamery Workbench candidate acquisition with vendored verifiable-handoff tarballs: `SATISFIED`, frozen lockfile, scripts ignored, explicit acquisition policy.
- Local `pnpm check`, package smoke, and real-repository acquisition dogfood are required PASS before publication.

## 0.1.0-alpha.2 — 2026-09-21

### Added

- Offline, content-addressed pnpm dependency acquisition/snapshots with sealed-tree verification and projection-based semantic execution.
- Workspace semantic entry-point completeness gates plus constrained derived TypeScript declaration artifacts.
- Candidate-selected TypeScript engine admission, including TypeScript 7 native-LSP runtime identity and exact-project alignment evidence.
- Persistent semantic runtime reuse keyed by candidate, snapshot, projection, resolving project, profile and isolation identities.
- Coordinate targeting context/guards and richer definition provenance for candidate, dependency, derived-artifact and toolchain targets.
- Realistic P7 benchmark reporting candidate ingestion, dependency materialization/verification, first/warm queries and concurrent reuse.

### Security / correctness

- Fail closed on unsupported pnpm workspace YAML/glob and package `exports` surfaces instead of silently shrinking semantic authority.
- Invalidate process-local verified leases when descendant filesystem metadata drifts, forcing full content re-verification before further VERIFIED answers.
- Prevent advisory/crashed/timed-out derived artifacts from becoming cache authority.
- Require snapshot-backed semantic sessions to execute through the bound dependency projection; snapshot-only manifests remain PARTIAL.
- Bind TypeScript 7 platform-native runtime bytes into engine identity and avoid sandboxed LSP client-PID watchdog exits.
- Add bounded compiler-timeout, cache-publication crash, tamper, routing, concurrent-runtime and semantic differential regression gates.
- Updated Vitest development tooling to 4.1.11, the first patched 4.x release for GHSA-82fw-gwwq-j7x9 / CVE-2026-84373.

### Maintenance

- Updated Zod from 4.6.1 to 4.6.5.
- Dependabot leaves semver-major npm and GitHub Actions upgrades for explicit review while continuing to surface patch/minor and security updates.

## 0.1.0-alpha.1 — 2026-09-18

First public alpha.

### Added

- Exact Git-candidate materialization independent of the live checkout.
- Content-addressed candidate, environment, profile, semantic-query, and artifact identities.
- TypeScript hover and definition through pinned TypeScript language tooling.
- CLI prepare/inspect/query/validate/close lifecycle.
- Candidate-bound MCP stdio server.
- Native `TRUSTED_LOCAL` execution profile.
- Linux `CONTAINER_READ_ONLY` execution profile.
- Independent receipt validation.
- Clean-install npm package and bundled CLI.
- GitHub Actions compatibility matrix and Linux container smoke.
- OpenCodeReview/Workbench external consumer adapter dogfood.

### Evidence

The release passed macOS 14 and Ubuntu 24.04 on Node 22.19 and 24.19, Linux Docker isolation smoke, and a clean public-registry A/B semantic smoke.

### Known limitations

Dependency-bearing projects remain `environment_binding=PARTIAL`; TypeScript is the only claimed language profile; dirty-worktree candidates, Windows, remote MCP, signatures, and additional semantic operations are outside this alpha.
