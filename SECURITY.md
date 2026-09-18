# Security Policy

## Supported versions

Review-LSP is currently an alpha project. Security fixes are applied to the latest published alpha and to `main`.

| Version | Supported |
| --- | --- |
| 0.1.0-alpha.x | Yes |
| older snapshots | No |

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** for this repository when available. Do not disclose a suspected vulnerability in a public issue.

Include, when possible:

- affected version or commit;
- operating system and Node.js version;
- the candidate/isolation mode involved;
- minimal reproduction steps;
- expected vs. observed trust boundary;
- whether source, environment, receipt, subprocess, or container identity can be bypassed.

If private vulnerability reporting is temporarily unavailable, use the contact method published on the maintainer's GitHub profile rather than opening a public issue.

## Security model

Review-LSP distinguishes evidence binding from semantic correctness.

Important boundaries:

- `TRUSTED_LOCAL` detects candidate mutation but is not a hostile-host sandbox.
- `CONTAINER_READ_ONLY` verifies a Linux read-only candidate mount and binds the exact container image identity, but does not protect against a malicious container host administrator.
- Receipts are tamper-evident hashes, not digital signatures.
- Dependency-bearing projects currently remain `environment_binding=PARTIAL` until dependency snapshots are admitted.
- Language-server output itself is not treated as proof that code is correct.

Security reports that demonstrate a way to bypass these stated boundaries are especially useful.
