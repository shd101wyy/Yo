# `includeDeclaration: false` keeps the declaration when the cursor sits on a `::` binding

**Severity:** S3 — `textDocument/references` with
`context.includeDeclaration == false` still lists the declaration occurrence
whenever the request's cursor is ON the declaration token of a `::` (comptime)
binding, and `textDocument/documentHighlight` calls that occurrence Text
instead of Write. Found 2026-09-30 by the closeout review of the
`includeDeclaration` fix that landed in #1020
(`issues/fixed/lsp-references-ignore-include-declaration.md`).

## Reproduction

```rust
answer :: (fn() -> i32)(i32(42));
main :: (fn() -> unit)({ println(answer().to_string()); () });
```

Send `textDocument/references` with `context.includeDeclaration: false` at
the `answer` in line 1 (the declaration): the reply lists BOTH occurrences —
the declaration was not dropped. The same request at the USE in line 2
correctly drops it. "Find references" from a declaration (the most common
entry point — right-click the definition) always showed the definition in
the result list.

## Root cause

The declaration is identified by comparing each occurrence against
`_binding_token_of`'s answer for the TARGET atom — but the `name :: value`
declaration atom's ExprInfo env predates the binding (documented in
`_collect_occurrences`), so `_binding_token_of` answers `.None` exactly when
the cursor is on the declaration. `decl` stayed empty and nothing was
dropped.

## Fix

When the env-based lookup answers `.None`, fall back to a syntactic walk of
the top-level binding forms (`name :: value`, `name := value`,
`(name : T) = value` — the same shapes `symbols.yo` walks) for the target's
name. Position-only labeling: an occurrence is only treated as the
declaration where it sits ON the returned token, so same-spelled locals in
deferred generic bodies are unaffected. This also restores the Write
documentHighlight kind on `::` declarations.
