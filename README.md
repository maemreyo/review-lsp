# Review-LSP

**Semantic context for the exact commit under review.**

Review-LSP runs LSP semantic queries against a Git candidate materialized from Git objects, not against whatever checkout happens to be live. Every successful query returns a content-addressed receipt binding candidate identity, source manifest, TypeScript server/compiler profile, document bytes, request position, result, environment state, and isolation mode.

Current public alpha: **0.1.0-alpha.1**.

Install explicitly with the prerelease tag:

```bash
npm install review-lsp@alpha
```

Because this is the first and currently only published version, npm also exposes it through the registry's required `latest` tag. Treat `@alpha` as the intentional installation channel until the first stable release moves `latest` to a stable version.

## Why

A live editor LSP answers questions about the workspace that is open now. Code review often needs a different subject: an exact commit or retained candidate. Review-LSP keeps that subject explicit and machine-checkable.

The public A/B demo creates:

- commit A: a symbol is a `string`;
- commit B: the same symbol becomes a `number`;
- live checkout: B;
- Review-LSP query bound to A: still returns A semantics.

A receipt proves which admitted inputs were used. It does **not** prove that the language server's semantic answer is correct.

## Alpha surface

- TypeScript first: pinned `typescript-language-server@6.0.0` + `typescript@6.0.3`.
- Candidate source from resolved local Git commits.
- Operations: hover and definition.
- CLI lifecycle: prepare, inspect, query, validate, close.
- MCP stdio tools:
  - `review_lsp_candidate_info`
  - `review_lsp_hover`
  - `review_lsp_definition`
- Query tools require `expected_candidate_id`.
- Native `TRUSTED_LOCAL` mode.
- Linux `CONTAINER_READ_ONLY` profile with read-only candidate mount and exact Docker image identity.
- Content-addressed artifact manifest for the bundled alpha CLI.

## Quickstart

```bash
npm install review-lsp@alpha
npx review-lsp artifact-info
```

For an existing repository:

```bash
npx review-lsp prepare /path/to/repo <commit> --state /tmp/review-lsp-state
```

The output includes `candidate_descriptor`. Then:

```bash
npx review-lsp query <candidate.json> hover src/example.ts 12 8
npx review-lsp query <candidate.json> definition src/example.ts 12 8
npx review-lsp validate <receipt.json>
npx review-lsp close <candidate.json>
```

Positions are 0-based LSP positions. The v0.1 TypeScript profile records UTF-16 position encoding.

Run an MCP server bound to one candidate at process start:

```bash
npx review-lsp serve /path/to/repo <commit> --state /tmp/review-lsp-state
```

Logs go to stderr; stdout is reserved for MCP.

Inspect the packaged provider identity:

```bash
npx review-lsp artifact-info
```

## Linux container profile

From source, build the alpha image:

```bash
pnpm container:build
pnpm test:container:linux
```

A container query uses:

```bash
node dist/review-lsp.mjs container-query \
  review-lsp:alpha-local \
  <candidate.json> hover src/example.ts 12 8 \
  --state /tmp/review-lsp-state
```

The outer process resolves the Docker image to an exact image ID. The inner Linux process must verify that `/candidate` is an explicit read-only mount before a receipt may say `isolation=CONTAINER_READ_ONLY`.

The container profile also uses a read-only root filesystem, no network, dropped Linux capabilities, `no-new-privileges`, bounded CPU/memory/pids, and writable tmpfs only for scratch/state.

## Evidence semantics

`source_binding=VERIFIED` means the retained source still matches the candidate manifest at the integrity checks required by the profile.

`environment_binding=VERIFIED` means the current environment admission found no unbound semantic input covered by the alpha profile. It is **not** a general statement that every project dependency is captured.

`environment_binding=PARTIAL` is expected when a project declares package dependencies or external config inputs that the alpha cannot snapshot/admit yet.

`TRUSTED_LOCAL` means native read-only files plus integrity checks. It is not a hostile-host sandbox and cannot rule out mutate-and-revert by a trusted host.

`CONTAINER_READ_ONLY` means the Linux runtime verified the candidate as a read-only mount and bound the Docker image ID into the environment manifest. It still does not protect against a malicious container host administrator.

Receipts are tamper-evident through canonical content hashing. They are not signatures.

## Release evidence

- GitHub Actions compatibility matrix: PASS on macOS 14 and Ubuntu 24.04 with Node 22.19.0 and 24.19.0.
- Linux Docker isolation smoke: PASS.
- Public npm registry clean-install A/B smoke: PASS.
- Published package: `review-lsp@0.1.0-alpha.1`.
- GitHub prerelease: `v0.1.0-alpha.1`.

See:

- `docs/status/H1.md`
- `docs/status/H3.md`
- `docs/status/H5.md`
- `docs/compatibility/0.1.0-alpha.1.md`
- `docs/releases/0.1.0-alpha.1.md`

## Current limitations

- Package dependency snapshots are not prepared/admitted yet. Dependency-bearing projects remain `PARTIAL`.
- JavaScript is not claimed as a supported alpha profile.
- Dirty-worktree candidates are not supported.
- References, symbols, and diagnostics are deferred.
- MCP is local stdio only.
- Windows is not part of the alpha compatibility claim.
- Native mode is not a hostile-host sandbox.
- No receipt is proof that reviewed code is correct.

## License

Apache-2.0. Direct runtime dependency license evidence is generated into `dist/review-lsp-licenses.json` during the alpha build.
