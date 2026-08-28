# A function tail with a deferred dup evaluates the tail call TWICE — a chained `Index` call there is a C redefinition

**Status: FIXED 2026-08-29** (`src/codegen/exprs/return.yo`, `handle_func_call_deferred_dup`).
**Found:** 2026-08-29 while writing `tests/encoding/csv.test.yo`'s helper
`_field :: (fn(rows, r, f) -> String)(rows(r)(f))`.
**Severity:** HIGH — one face is a loud C error, the other a SILENT double
evaluation of any side-effecting tail call whose result is an RC value.

## Symptom

```
error: redefinition of '__yo_idx_tmp_76328'
```

for

```rust
pick :: (fn(rows : ArrayList(ArrayList(String)), r : usize, f : usize) -> String)(rows(r)(f));
```

The emitted C:

```c
__yo_t6* __yo_idx_tmp_76328 = (*index(&rows, r));            // outer Index's spill of rows(r)
__yo_t2 _file____priv_temp_8437 = (*index(&__yo_idx_tmp_76328, f));
/* dup of the temp */
return (*index(&(*index(&rows, r)) ...));                     // the WHOLE expression, generated again
```

The second generation re-declares the Index spill (same AST id → same temp
name) and, semantically, indexes twice. With a user `Index` impl that counts
calls, `first_of :: (fn(c : Counter) -> String)(c(usize(0)))` recorded TWO
hits per call before the fix.

## Mechanism

`handle_func_call_deferred_dup` (the tail/return path for a call whose result
carries `deferred_dup_expressions`) generates the call into the evaluator's
temp variable (`T temp = <call>;`), runs the dup pass, and then returns the
code the CALLER should read. That last step returned the dup expression's
variable name when the dup expr was a call with a variable — and otherwise
fell through to `_call_generate_expr(expr, ...)`: a fresh generation of the
whole tail expression, side effects included. The temp holding the (now
dup'd) value was never handed back.

## Fix

Remember the temp the value was generated into (`value_var`) and return it
after the dup pass. The `.None` arm (the evaluator assigned no temp at all)
still emits the call as a statement and regenerates — TS's
`handleFuncCallDeferredDup` does the same there, and no shape reaching that
arm has been found; it is a suspected sibling, left with this note rather
than changed blind.

## Regression test

`tests/deferred_dup_return_single_eval.test.yo` — the chained-Index tail
(RED: the C redefinition) and a counting `Index` impl proving one evaluation
per call.
