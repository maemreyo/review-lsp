# Contributing to Review-LSP

Thanks for considering a contribution.

Review-LSP is intentionally small and evidence-oriented. Changes that affect candidate identity, semantic execution, receipts, isolation, or release evidence should preserve fail-closed behavior and make their trust boundary explicit.

## Before opening a pull request

1. Search existing issues and pull requests.
2. For substantial API, receipt-schema, isolation, or architecture changes, open an issue first so the contract can be discussed before implementation.
3. Keep changes scoped. Consumer-specific integrations belong outside the standalone core unless they generalize cleanly.

## Development setup

Requirements:

- Node.js 22.19+ or 24.x
- pnpm 10.20.0
- Git
- Docker only for the Linux container profile

This repository is managed with pnpm:

```bash
pnpm install --frozen-lockfile
pnpm check
```

Do not run `npm install` inside this source checkout after pnpm has created `node_modules`. Use a separate temporary consumer directory when testing the published npm package.

Useful commands:

```bash
pnpm typecheck
pnpm test:unit
pnpm test:acceptance
pnpm demo:ab
pnpm test:mcp:stdio
pnpm test:package
pnpm benchmark
```

On a Linux host with Docker:

```bash
pnpm container:build
pnpm test:container:linux
```

## Evidence rules

A successful command is not automatically exact-candidate evidence.

When changing evidence or receipt behavior:

- keep source, environment, profile, operation, and result identities explicit;
- preserve `VERIFIED`, `PARTIAL`, `UNKNOWN`, and `INVALID` distinctions;
- never upgrade missing or unbound evidence to `VERIFIED`;
- keep live-workspace LSP output separate from retained-candidate semantics;
- add a regression test for every fail-closed path you change.

If a project dependency or config input is outside the admitted environment, the result must remain `environment_binding=PARTIAL`.

## Pull requests

A good pull request should include:

- what problem is being solved;
- what trust boundary or invariant changes, if any;
- tests or receipts that demonstrate the behavior;
- known limitations or unsupported cases;
- documentation changes for any public behavior.

Please keep generated artifacts and local state out of commits.

## Style

- TypeScript ESM.
- Prefer small, explicit functions over hidden process-global behavior.
- Avoid network access in semantic execution unless a future profile explicitly admits and binds it.
- Do not weaken resource bounds or subprocess cleanup without a documented reason.

## Security issues

Do not open a public issue for a suspected vulnerability. See [SECURITY.md](SECURITY.md).
