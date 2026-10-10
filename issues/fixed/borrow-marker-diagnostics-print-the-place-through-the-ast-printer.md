# Borrow-marker diagnostics printed the place through the AST printer

**Severity:** S3 — a diagnostic's suggested repair (`addr_of(((self.(*)).buf))`) was not code the user could type

> Found 2026-10-10 while turning the address-of `&x` into an error (V3b
> Generation B step 3, `plans/VALUES_BY_DEFAULT.md`). **FIXED same branch**
> (feat/vbd-v3b-addr-of-delete-inout).

## Symptom

`yo check` of the compiler tree against the un-migrated `markdown_yo`
dependency reported:

```text
error: Parameter "out" is a raw pointer (`*(ArrayList(u8))`): take the address with `addr_of(((self.(*)).buf))`. `&((self.(*)).buf)` lends a borrow to an `imm` parameter and never makes a pointer.
    --> .../markdown_yo/src/renderer.yo:523:16
523 |     append_lit(&(self.*.buf), s)
```

The source says `self.*.buf`; the message says `((self.(*)).buf)`, and
`self.(*)` is the dynamic-member syntax, so the suggested `addr_of(...)` is
not even the same expression. The `&mut x` mismatch messages that predate the
step (`` `&mut x` lends an exclusive borrow, but parameter "p" is not `mut` ``)
built their text the same way.

## Root cause

`apply_call_site_borrow_markers` (`src/evaluator/calls/helper.yo`) and the
evaluator's `&x` arm (`src/evaluator/exprs/_expr.yo`) printed the place with
`ast_expr_to_string`, the debugging printer, which parenthesizes every
operator node and prints the `.*` step as `.(*)`.

## Fix

`ast_place_text` (`src/expr.yo`) prints a place as it is written: a name, a
field step `a.b`, a dereference step `a.*`, a call `f(args)`; anything else
falls back to `ast_expr_to_string`. Both diagnostic sites use it.

## Verification

`tests/addr_of.test.yo` ("&x to a raw-pointer parameter is an error naming
addr_of(x)") expects `take the address with `addr_of(b.n)`` for
`_ao_write(&b.n, …)`; before the fix the message said `addr_of((b.n))`.
