# Current support matrix

Baseline release: `review-lsp@0.1.0-alpha.5`.

This file describes current support. Historical H0/H1/H3/H5 documents record the gates that existed when those milestones were closed and may contain wording that was correct for an older alpha.

| Surface | Current state | Boundary |
| --- | --- | --- |
| Candidate source | VERIFIED for admitted exact Git commits | Git object DB; dirty-worktree candidates are not authority |
| Language | TypeScript | No broad JavaScript/other-language claim |
| Package manager | pnpm 10 admitted subset | Other/unsupported shapes fail closed or remain unsupported |
| Dependency inputs | Implemented | Frozen lockfile/config/workspace inputs are content-addressed |
| Dependency snapshots | Implemented for admitted subset | Not a claim of arbitrary dependency-project completeness |
| Candidate-local `file:` dependency | Admitted only for unique candidate-contained `.tgz` artifacts | Local directories, escaping/ambiguous/non-tarball refs are unsupported |
| Build scripts | Not arbitrary | Acquisition ignores lifecycle scripts; only constrained derived-declaration flow is admitted |
| Semantic projection | Implemented | Candidate source remains authority; admitted dependencies/derived artifacts are projected |
| TypeScript engine | Bundled compatibility profile or candidate-selected admitted engine | Exact-project alignment is recorded separately from environment reproducibility |
| Project references | Admitted for the Alpha.5 candidate-contained subset | Directory and admitted explicit-config targets are graph-bound; unsupported/missing/escaping/ambiguous shapes prevent strong environment admission; not universal build-mode completeness |
| Operations | hover, definition, references, document diagnostics | References bind declaration-inclusion and target provenance; diagnostics are engine-full-document semantic responses, not project-wide build correctness; symbols remain deferred |
| Native isolation | TRUSTED_LOCAL | Host itself is trusted |
| Linux isolation | CONTAINER_READ_ONLY | Exact image/mount identity is bound; malicious host admin is out of scope |
| OS evidence | macOS + Linux | Windows is not claimed |
| MCP | local stdio | No remote MCP claim |
| Receipts | content-addressed/tamper-evident | Not signed; do not prove semantic correctness |

A dependency-bearing repository can reach `environment_binding=VERIFIED` only when every semantic input required by the active profile is admitted: dependency inputs/snapshot, projection, config and entry-point gates, toolchain and isolation requirements. Unsupported or ambiguous inputs keep the result PARTIAL/UNSUPPORTED rather than being silently ignored.

Alpha.5 project-reference authority is `docs/design-notes/ALPHA5_PROJECT_REFERENCE_MASTER_PLAN.md`. Alpha.4 semantic-operation authority remains preserved in `docs/design-notes/ALPHA4_SEMANTIC_IMPACT_MASTER_PLAN.md`; later expansion must preserve the same candidate/environment/toolchain evidence boundaries.
