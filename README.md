# Review-LSP

**Semantic context for the exact commit under review.**

Review-LSP runs LSP semantic queries against a Git candidate materialized from Git objects, not against whatever checkout happens to be live. Every successful query returns a content-addressed receipt binding the candidate, source manifest, TypeScript server/compiler profile, document bytes, request position, result, environment state, and native isolation level.

This repository is currently an implementation worktree, not a published npm package. Do not use an npm install command until an alpha artifact is actually published.

## What works now

- Local Git commit candidates resolved to full object IDs.
- Source materialized with `git ls-tree` + `git cat-file`; live checkout bytes are not used.
- Fail-closed handling for submodules, unresolved LFS pointers, path/case collisions, escaping/cyclic symlinks, candidate mutation, and profile mutation.
- TypeScript hover and definition using pinned `typescript-language-server@6.0.0` + `typescript@6.0.3`.
- CLI prepare/inspect/query/validate/close.
- MCP stdio tools:
  - `review_lsp_candidate_info`
  - `review_lsp_hover`
  - `review_lsp_definition`
- Query tools require the expected candidate ID.
- Native mode is explicitly `TRUSTED_LOCAL`, not hermetic isolation.

## Local quickstart

```bash
pnpm install
pnpm build
pnpm demo:ab
```

The demo creates two commits: A exports a `string`, B exports a `number`, leaves the live checkout at B, then asks both candidate sessions about the same symbol. A must still return string semantics and B number semantics.

For an existing repository:

```bash
node dist/src/cli.js prepare /path/to/repo <commit> --state /tmp/review-lsp-state
```

The output includes `candidate_descriptor`. Then:

```bash
node dist/src/cli.js query <candidate.json> hover src/example.ts 12 8
node dist/src/cli.js query <candidate.json> definition src/example.ts 12 8
node dist/src/cli.js validate <receipt.json>
```

Positions are 0-based LSP positions. The v0.1 TypeScript profile records UTF-16 position encoding.

Run an MCP server bound to one candidate at process start:

```bash
node dist/src/cli.js serve /path/to/repo <commit> --state /tmp/review-lsp-state
```

Logs go to stderr; stdout is reserved for MCP.

## Evidence semantics

`source_binding=VERIFIED` means the retained source still matches the candidate manifest before and after the query. `environment_binding=VERIFIED` means the currently implemented environment admission found no unbound project dependency/config input. Neither means the language server is semantically correct.

A receipt is tamper-evident through canonical content hashing. It is not a signature and does not protect against a trusted host fabricating an entirely new evidence set.

## Current limitations

- Package dependency snapshots are not yet prepared/admitted. A project declaring dependencies is marked `environment_binding=PARTIAL`.
- Native read-only files + pre/post hashing are `TRUSTED_LOCAL`; they do not prevent a malicious host administrator or mutate-and-revert attack.
- Container/read-only-mount isolation for untrusted PRs is not complete.
- TypeScript only. References/symbols/diagnostics are intentionally deferred.
- MCP is local stdio only.
- No OpenCodeReview/Pi/Workbench adapter is included in core yet.

See `docs/adr/0001-standalone-candidate-lsp.md` and milestone status files for the exact implementation boundary.
