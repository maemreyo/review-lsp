# Support

Use the channel that matches the request:

- **Bug or reproducible defect:** open a Bug Report issue.
- **Feature or design proposal:** open a Feature Request issue.
- **Usage question or integration discussion:** use GitHub Discussions.
- **Security vulnerability:** follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting.

Before opening a bug, please include the output of:

```bash
npx review-lsp@alpha artifact-info
node --version
```

For candidate-specific failures, include the operation, candidate type, relevant binding state, and a minimal repository or reproduction when possible. Do not include secrets or private source code in public reports.
