# Cache identity must be separate from provenance identity

Status: **design requirement for P4** — recorded during P1, not implemented by it.

## Observation

`candidate_id` binds `repository_identity`, and `repository_identity` hashes the absolute Git
directory:

```text
repository_identity = sha256({ git_dir, object_format })
candidate_id        = contentId("cand", { …, repository_identity, …, entries })
```

OpenCodeReview captures each review into its own linked worktree, so every capture has a
distinct `--absolute-git-dir`:

```text
<main-repo>/.git/worktrees/rv_<hash>-p<pid>-<uuid>
```

Every existing capture on this host resolves to a unique Git directory. The consequence is
that **two reviews of the same commit produce two different `candidate_id` values**, even
though the tree, every path, every blob OID and the whole manifest are identical.

## This is correct behaviour, not a defect

`candidate_id` is a provenance identity. It answers "which repository did this candidate come
from, and what exactly was in it". Binding the repository into that identity is what lets a
receipt state where evidence originated. It should not be redefined as content-only.

## What P4 must not do

P4 specifies that the reuse cache key "includes exact candidate and semantic environment
identities". If that key is `candidate_id`, the candidate cache can never hit across reviews,
because the key changes with every capture worktree. The dependency snapshot and the semantic
session both hang off the candidate, so the reuse P4 exists to deliver would be defeated for
precisely the workflow it targets.

## Requirement

Introduce a separate identity for immutable source material — for example
`source_content_id` / `candidate_material_id` — derived from candidate content alone:
schema version, object format, tree OID and source manifest digest, with no repository path
component.

Then:

- **reuse and caching** key on content identity;
- **provenance and receipts** continue to carry `candidate_id` and `repository_identity`
  unchanged;
- **dependency snapshots** key on their own dependency content identity, not on
  `candidate_id`, so one snapshot serves every review of a given dependency input set;
- **semantic sessions** may remain review- or candidate-scoped, since their lifetime is a
  policy decision rather than a content one.

Separating the two identities is the requirement. Making `candidate_id` content-only is not,
and would weaken provenance.

## Evidence recorded during P1

The baseline harness already had to split these two notions apart for its own parity
contract: see `identity.content` versus `identity.location_bound` in
`docs/baselines/README.md`. The same split is what P4 needs at the cache layer.
