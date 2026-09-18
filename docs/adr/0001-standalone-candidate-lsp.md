# ADR 0001 — Standalone candidate-bound LSP driver

Status: ACCEPTED for H0–H2, 2026-09-18.

## Decision

Review-LSP core is standalone. It does not import Pi, Zamery Workbench, or OpenCodeReview runtime packages.

The first driver is a thin stdio LSP client built on `vscode-jsonrpc`, `vscode-languageserver-protocol`, and `vscode-uri`. The TypeScript profile pins `typescript-language-server` and the TypeScript compiler it delegates to.

## Reuse observations

- Zamery `pi-open-code-review` already contains candidate-bound hover code and receipt concepts, but those APIs are coupled to review records and Zamery state.
- `pi-lsp-adapter@0.1.3` is MIT and contains a reusable LSP client design with explicit root/config/spawner, but the published package is a Pi extension whose lifecycle, process registry, configuration, cache, and UI are workspace-oriented.
- For v0.1 we reuse protocol patterns and upstream protocol libraries, not either runtime package.
- OpenCodeReview and Pi/Workbench remain consumers/adapters.

## Why not mcpls as the first backend

An MCP↔LSP bridge solves transport and generic semantic queries, but H0 requires Review-LSP itself to bind candidate root, exact document bytes, admitted server/compiler identity, environment, session epoch, and receipt storage. Wrapping tool output would not prove those inputs.

## Threat model

The native profile is `TRUSTED_LOCAL`. Candidate files are copied from Git objects into a managed root and made read-only after preparation. Integrity is verified before and after requests. This detects ordinary mutation but is not a hermetic boundary against a malicious host administrator or mutate-and-revert attacks.

Untrusted PR execution requires a later enforced isolation profile (container/read-only mount). No stronger claim is made in H0–H2.

## Toolchain observed

- Node 24.19.0
- pnpm 10.20.0
- TypeScript language server 6.0.0
- TypeScript 6.0.3 (pinned after H0 compatibility inspection; 7.0.2 did not expose the tsserver layout expected by the selected TypeScript language server profile)
- vscode-jsonrpc 9.0.2
- vscode-languageserver-protocol 3.18.3
- vscode-uri 3.2.0

Versions are pinned in the repository. A profile also records content digests; version strings alone are not admission.
