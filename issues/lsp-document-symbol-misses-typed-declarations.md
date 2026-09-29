# `documentSymbol` misses typed top-level declarations and uses the name token as the whole range

**Severity:** S3 — outline/breadcrumb coverage gap plus a cosmetic range limitation; no incorrect navigation, just missing entries.

## Reproduction

`plans/LSP_AUDIT_2026-09-29.md` probe session A. Document:

```rust
Point :: struct(x : i32, y : i32);
(p : Point) = Point(x : 1, y : 2);
answer :: (fn() -> i32)({ return(((p.x) + (p.y))); });
```

`textDocument/documentSymbol` returns exactly two symbols: `Point` (Struct)
and `answer` (Function). The typed top-level declaration `p` (line 1) is
absent. `handle_document_symbols` (`src/lsp/symbols.yo`) walks only
`ast_expr_is_fn_call_of(e, "::", 2)` statements.

The `(name : T) = value` form is not exotic — it is how every module in
`src/` declares a mutable module constant (`(g_shutdown_requested : bool) =
false;` in `src/lsp/server.yo` itself), so the outline of any real compiler
file omits a class of its bindings.

Also recorded here (same function): `range` and `selectionRange` are both the
NAME token, not the binding's full span. The spec wants `range` to cover the
whole symbol (VS Code folds outline rows on it). Computing a subtree end
needs a max-end token walk; acceptable to leave as a known limitation and fix
only the missing entries first.

## Fix

In `handle_document_symbols`, also accept a top-level infix `=` call with two
arguments whose first argument is an `name : T` pair with an Atom left side:
emit a Variable symbol (kind 13) for that Atom's token, same range shape as
the `::` entries. Kind stays syntactic like the rest of the classifier
(fn-typed RHS could be 12 — follow `_symbol_kind_of` on the RHS for
consistency, since `(f : fn(i32) -> i32) = …` is legal too).

## Test

Extend the `lsp-handshake` document (or the documentSymbol request in
`lsp-completion`'s fixture session) with a typed declaration and hand-author
the golden's extra entry; plus an `internal` unit test on
`handle_document_symbols` next to the existing ones in
`tests/internal/lsp_protocol.test.yo` if the harness shape allows (it takes
`exprs` + `lines`, so it does).
