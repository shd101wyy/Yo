# The pragma registry compared module paths raw — spelling-sensitive lookups silently missed

**Status: FIXED** (rides the V7 LSP-hover PR; canonicalized at the registry).

**Date found:** 2026-09-19 (V7 task 1 — LSP contract hover).

## Symptom

An LSP hover on a function in a document carrying `pragma(Pragma.Verify);`
reported `verification mode: runtime` — the mode lookup missed the pragma
the document itself had declared during the very same analysis pass.

A standalone probe (`tmp/lspmode.yo`, the `_analyze` → `file_has_pragma`
flow) measured it directly:

```
after-analyze: plain_has=false uri_has=true mode=runtime
```

The pragma WAS registered — under the `file://<abs>` cache-key spelling —
while the reader asked with the plain filesystem path. `==` on the two
strings is always false.

## Root cause

`src/evaluator/memory_safety.yo`'s per-file privilege registry stored and
compared `module_path` strings RAW. Two spellings of one module coexist by
design (AGENTS.md): the ENTRY module's tokens carry the path as typed,
demand-loaded modules' tokens carry the `file://<abs>` cache key — and,
measured here, the LSP's evaluation of an open document registers pragmas
under the `file://` spelling while hover is handed the plain path. Any
reader whose spelling differs from the writer's silently misses: no error,
no warning, just the default answer.

The CLI flows happened to agree by construction (the verify driver reads
demand-loaded files through their `file://` keys), which is why this only
surfaced through the LSP.

## Fix

`canonical_module_path` (src/utils.yo — the documented remedy: "two paths
naming the same file must never be compared with ==") applied at the
registry itself:

- `register_file_pragma` stores the CANONICAL key;
- `file_has_pragma` canonicalizes the query before comparing;
- `_clear_pragma_for_module` (LSP invalidation) canonicalizes its argument.

All existing consumers (the AllowUnsafe/AllowMacroDef pointer-op gates,
`resolve_verify_mode`) keep their call shapes; lookups are now insensitive
to which spelling either side held.

## Test

`tests/internal/lsp_protocol.test.yo` — "hover shows contracts +
verification status for a contracted function" asserts the mode line reads
`verify` for a `pragma(Pragma.Verify);` document analyzed through the real
`analyze_document` flow.
