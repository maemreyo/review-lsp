# Changelog

All notable public changes to Review-LSP are recorded here.

The project is currently prerelease software. Until 1.0, minor versions may include breaking changes when the evidence model or public surface needs to evolve.

## Unreleased

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
