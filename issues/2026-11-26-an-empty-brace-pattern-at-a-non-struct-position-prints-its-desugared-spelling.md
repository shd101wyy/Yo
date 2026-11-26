# An empty-brace pattern `{}` at a non-struct position prints its desugared spelling `_()`

**Severity:** S3 — `match(u, {} => …)` on a `unit` (or any non-struct) scrutinee fails with the uncoded "Pattern _() needs a struct value to match against, but this position has type unit": the message names the parser's internal record call `_()`, not what the user wrote, and has no code or help.

- Filed: 2026-11-26 (lane `v81-bare-variant`, from VERDICTS-88 §9, probe `e3`/`e4`), with the v0.2.80 seed.

## Reproducer

```yo ignore
a :: (fn(u : unit) -> i32)(match(u, {} => i32(1)));
export(a);
```

```text
error: Pattern _() needs a struct value to match against, but this position has type unit
  --> tmp/fixme.yo:1:37
```

The same on an `i32` scrutinee.

## Root cause

In pattern position `{}` parses as the anonymous record call `_()` (a field list naming no fields). `compile_pattern`'s anonymous-struct branch (`src/evaluator/exprs/pattern-compile.yo`, "`{x : p, y}` — the anonymous record pattern") formats the error with `ast_expr_to_string(e)`, which prints the desugared call, and attaches no code.

## Fix direction

Print the record pattern as written (`{}` / `{ x : p }`), code it E0609, and add a help: a non-struct position is matched with `_`, a binding or a constant. A `comptime_expect_error` case in `tests/match-structs.test.yo`.
