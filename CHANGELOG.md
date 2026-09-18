# Changelog

All notable public changes to Review-LSP are recorded here.

The project is currently prerelease software. Until 1.0, minor versions may include breaking changes when the evidence model or public surface needs to evolve.

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
