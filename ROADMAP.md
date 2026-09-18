# Roadmap

Review-LSP is intentionally developing from a narrow, verifiable vertical slice rather than expanding the API faster than the evidence model.

This is a direction document, not a compatibility promise.

## Near term

### Dependency snapshots

Allow dependency-bearing TypeScript projects to reach `environment_binding=VERIFIED` by preparing and admitting immutable dependency snapshots instead of relying on ambient `node_modules`.

### More semantic operations

Likely candidates:

- references;
- document/workspace symbols;
- diagnostics;
- richer definition/result provenance.

Each operation should preserve the same candidate, environment, profile, document, request, and result binding model.

### Consumer integration

Make external Review-LSP provider setup simpler for code-review tools while keeping the standalone core consumer-neutral.

### Release ergonomics

- clearer artifact/provider identity for consumers;
- easier container-image distribution;
- better benchmark history and compatibility evidence.

## Later

Potential additional language profiles should be added only when their server/toolchain/config/dependency inputs can be admitted with equivalent provenance.

## Non-goals for the current alpha line

- treating live editor state as review authority;
- silently downloading dependencies during semantic execution;
- claiming semantic correctness from an LSP response;
- turning PARTIAL or UNKNOWN evidence into VERIFIED;
- building consumer-specific policy into the standalone core.
