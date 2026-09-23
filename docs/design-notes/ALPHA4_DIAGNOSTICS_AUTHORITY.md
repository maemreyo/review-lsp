# Alpha.4 diagnostics authority contract

Status: FROZEN FOR IMPLEMENTATION  
Frozen against candidate baseline: `8080d3fcd78c4d299aa884c2dccd1373b9469ed0`  
Scope: Review-LSP Alpha.4 vertical slice B

## 1. Decision

Alpha.4 exposes **document diagnostics only**.

The public operation is one bounded semantic question:

```text
diagnostics(path)
```

It answers:

> Which diagnostics does the admitted semantic engine report for this exact opened candidate document under this exact candidate/environment/toolchain/session binding?

It does **not** answer:

- whether the repository builds;
- whether every project file is valid;
- whether every configured build target was checked;
- whether tests, lint, bundling, code generation, framework transforms, or arbitrary build scripts succeed;
- whether diagnostics outside the requested document are absent.

No workspace/project-wide diagnostics operation is part of Alpha.4.

## 2. Why Alpha.4 does not use bounded publishDiagnostics timing

The bundled `typescript-language-server@6.0.0` implementation supports push diagnostics but does not advertise a document `diagnosticProvider`. Its push path aggregates tsserver syntax, semantic, and suggestion events and publishes them asynchronously.

Alpha.4 does not use a quiet-window/deadline heuristic as authority because silence is not a completion signal.

A runtime probe established a deterministic request/response path for that engine: its advertised `typescript.tsserverRequest` command successfully forwards these synchronous tsserver commands for an opened document:

1. `syntacticDiagnosticsSync`
2. `semanticDiagnosticsSync`
3. `suggestionDiagnosticsSync`

The TypeScript 7 native LSP (`typescript-go 7.0.2`) instead advertises:

```text
diagnosticProvider.identifier = "typescript"
diagnosticProvider.interFileDependencies = true
diagnosticProvider.workspaceDiagnostics = false
```

and returns a deterministic `textDocument/diagnostic` response.

Therefore Alpha.4 uses request/response transports only. Push diagnostics may be observed for debugging, but they are not authoritative evidence.

## 3. Engine transport matrix

### 3.1 Standard LSP document diagnostic transport

Use when the initialized server advertises `diagnosticProvider`.

Required request:

```text
textDocument/diagnostic
```

Alpha.4 sends no `previousResultId` and advertises `textDocument.diagnostic.relatedDocumentSupport=false`. A successful authoritative response must therefore be a full report for the requested document only. An `unchanged` report without a prior result bound into this request is rejected. A response containing `relatedDocuments` is also rejected rather than silently widening the operation beyond document scope.

Current admitted example: TypeScript 7 native LSP.

### 3.2 TypeScript legacy synchronous transport

Use only when the initialized server advertises `workspace/executeCommand` with the exact command:

```text
typescript.tsserverRequest
```

For the already opened document, Review-LSP issues all three commands in this exact order:

```text
syntacticDiagnosticsSync
semanticDiagnosticsSync
suggestionDiagnosticsSync
```

Every response must:

- be a successful tsserver response;
- name the requested command;
- contain an array body;
- arrive before the existing semantic request deadline.

If any one of the three subrequests fails, times out, is malformed, or is unsupported, the diagnostics operation fails closed. Alpha.4 must not persist an authoritative partial diagnostics receipt.

Current admitted examples:

- bundled `typescript-language-server@6.0.0` + bundled compatibility TypeScript;
- `typescript-language-server@6.0.0` + an admitted candidate `TSSERVER_LEGACY` engine.

### 3.3 Unsupported engines

If neither deterministic transport is admitted by initialized server capabilities, `diagnostics` is unsupported.

Do not fall back to:

- waiting for `publishDiagnostics`;
- compiler stderr parsing;
- `tsc --noEmit`;
- derived-artifact compiler diagnostics;
- Workbench or consumer-side diagnostics.

Those are different evidence domains.

## 4. Open-document authority

A diagnostics query opens exactly one admitted candidate source document through the same immutable session machinery already used by hover/definition/references.

The receipt binds:

- candidate-relative path;
- execution URI;
- candidate-source SHA-256;
- document version;
- language id;
- UTF-16 position encoding where ranges use LSP coordinates.

The document version is immutable within one semantic session. If the same URI is already open with different bytes or language id, the operation fails.

Diagnostics may depend on imports and project state. Those dependencies are covered by the existing environment/projection/toolchain binding, not by expanding the requested document set.

## 5. Separate receipt schema

Do not distort `review-lsp.receipt.v1`, which is point-query shaped and requires line/character plus coordinate context.

Diagnostics uses a separate content-addressed schema:

```text
review-lsp.diagnostics-receipt.v1
```

The receipt reuses the same authority fields as semantic receipts:

- candidate identity;
- environment manifest identity;
- profile identity;
- session id and epoch;
- source binding;
- environment binding;
- semantic toolchain evidence;
- isolation evidence;
- request duration;
- result digest;
- observed timestamp.

Diagnostics-specific fields are:

```text
operation = "diagnostics"

document = {
  path,
  uri,
  sha256,
  version,
  language_id,
  position_encoding
}

request = {
  scope: "document"
}

transport = {
  kind:
    | "LSP_DOCUMENT_DIAGNOSTIC"
    | "TSSERVER_SYNC_DIAGNOSTICS",
  protocol_operations: [...]
}

result_scope = "DOCUMENT_DIAGNOSTICS"
completeness = "ENGINE_FULL_DOCUMENT_RESPONSE"
```

`ENGINE_FULL_DOCUMENT_RESPONSE` means complete for the selected engine's deterministic document-diagnostics contract at that observation. It does not mean build, repository, or workspace completeness.

The receipt id is content-addressed over every stable field except `receipt_id`, following the existing receipt publication model.

## 6. Normalized diagnostic result

Both engine transports normalize into one consumer-neutral result.

Each diagnostic contains:

```text
kind:
  | "syntactic"
  | "semantic"
  | "suggestion"
  | "engine"

range: {
  start: { line, character },
  end:   { line, character }
}

severity:
  | "error"
  | "warning"
  | "information"
  | "hint"
  | "unknown"

code: string | number | null
source: string | null
message: string

tags: {
  unnecessary: boolean,
  deprecated: boolean
}

related_information: [...]
```

For the TypeScript legacy transport, the three source commands set `kind` directly. TypeScript protocol line/offset coordinates are converted from 1-based locations to 0-based UTF-16 LSP-style ranges.

For native LSP, diagnostics are normalized from the returned `Diagnostic[]`; `kind` is `"engine"` because the native full report does not expose the legacy syntax/semantic/suggestion partition.

Legacy TypeScript categories map `error -> error`, `warning -> warning`, `suggestion -> hint`, and `message -> information`. Native LSP severities map LSP 1/2/3/4 to error/warning/information/hint. Missing or unknown severity/category values become `"unknown"`; they are not silently upgraded or dropped. LSP diagnostic tags 1/2 and legacy `reportsUnnecessary` / `reportsDeprecated` map to the normalized tag booleans.

## 7. Related-information provenance

Every related-information location must be classified using the same admitted-root model used for definition/references:

- `SOURCE_CANDIDATE`;
- `DEPENDENCY_SNAPSHOT`;
- `DERIVED_WORKSPACE_ARTIFACT`;
- `TOOLCHAIN_TYPESCRIPT`;
- `TOOLCHAIN_SERVER`;
- `UNBOUND`.

Each related-information entry records:

- message;
- code when available;
- category/severity when available;
- normalized range when available;
- original target URI/path;
- semantic target binding.

If any related-information location is `UNBOUND`:

- retain the diagnostic;
- downgrade `environment_binding` to `PARTIAL`;
- add an explicit limitation.

No external URI becomes trusted by appearing inside a diagnostic.

## 8. Deterministic canonicalization

Before hashing or persistence:

1. normalize engine-specific diagnostics into the Alpha.4 result model;
2. normalize related-information entries;
3. sort related information deterministically;
4. sort diagnostics deterministically by:
   - start line;
   - start character;
   - end line;
   - end character;
   - severity;
   - code;
   - source;
   - message;
   - kind;
5. preserve duplicate diagnostics if the engine emits distinct duplicates; do not silently deduplicate unless the exact normalized objects are byte-identical and the implementation explicitly records that policy.

The result hash is SHA-256 over canonical JSON, as with existing semantic receipts.

## 9. Binding and limitations

The same strong-admission rules used by current semantic queries apply.

If project toolchain alignment blocks strong admission:

- the query may still return deterministic diagnostics;
- `environment_binding` becomes `PARTIAL`;
- the exact reason is retained in limitations.

Every diagnostics receipt includes this limitation:

```text
document diagnostics are language-service semantic evidence for the requested document;
they are not proof of project-wide build, test, lint, bundler, framework, or code-generation correctness
```

For legacy sync diagnostics, the receipt also states that completeness is limited to the fixed syntax/semantic/suggestion tsserver diagnostic set.

For native pull diagnostics, the receipt records the server's diagnostic-provider metadata, including `interFileDependencies` and `workspaceDiagnostics`.

## 10. Resource and failure policy

Diagnostics inherits the existing document byte limit and semantic result byte limit.

Additionally:

- all subrequests share the existing semantic request timeout budget;
- result normalization must be bounded by the existing result byte limit;
- malformed ranges, malformed related-information locations, or malformed transport responses fail the operation rather than being silently repaired;
- candidate/profile/environment integrity is checked before and after the engine call, matching current semantic-query fencing;
- no authoritative receipt is persisted after a failed integrity recheck.

## 11. Public exposure gate

Do not add diagnostics to CLI, container, MCP, package exports, `candidateInfo().capabilities`, or Workbench until all of these are implemented and green:

- the two transport paths above;
- normalized diagnostics;
- related-information provenance;
- diagnostics receipt persistence + tamper validation;
- TypeScript 6 legacy differential tests;
- TypeScript 7 native differential tests;
- clean/error documents;
- related-information fixtures;
- dependency/derived provenance fixtures where applicable;
- capability-negative tests;
- timeout/malformed-response fail-closed tests;
- independent candidate-bound code review.

Public capability advertisement must be based on the initialized engine transport actually admitted for diagnostics. Never advertise diagnostics merely because Review-LSP as a package knows how to implement it.

## 12. Acceptance boundary

Alpha.4 diagnostics is accepted only when:

- TypeScript 6 legacy diagnostics match independently queried sync tsserver diagnostics on representative fixtures;
- TypeScript 7 native diagnostics match an independently started native LSP document-diagnostic response after normalization;
- repeated queries on an immutable candidate are deterministic after normalization;
- candidate/environment/toolchain/session identities are unchanged by the query;
- receipt tampering is detected;
- no test or API describes the result as project/build correctness.

Symbols remain outside this authority decision and are evaluated only after diagnostics is complete.
