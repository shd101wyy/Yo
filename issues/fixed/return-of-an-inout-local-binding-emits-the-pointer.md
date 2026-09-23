# `return(<inout local binding>)` returns the raw pointer as the value for non-RC types

**Status:** FIXED 2026-09-23
**Severity:** wrong code in safe code. An `inout(name) := place` local binding
returned from its own function emits the C pointer variable where the value is
expected: an i32 function returns pointer bits (a garbage integer that also
leaks a stack address), and any non-RC type with a different C shape fails to
compile or returns reinterpreted bytes. RC-typed bindings were already correct
(their return goes through the deferred-dup path, which reads through the
reference).
**Found:** 2026-09-23, during the adversarial memory-safety sweep requested
after the `plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` audit — a direct
contradiction of the audit's §2 claim that the escape channels "stay closed
for free (… copies copy the pointee)".

## Reproducer

```rust
f :: (fn() -> i32)({
  x := i32(1);
  inout(y) := x;
  y = i32(2);
  return(y); // copies the pointee: should return 2
});
```

Emitted C (v0.2.39, `--optimize 2`):

```c
static inline int32_t yo_id_...() {
  int32_t x = 1;
  int32_t* y = (&(x));
  int32_t _file_... = (*y); // Save old value for later use
  (*y) = 2;
  return y;                 // the POINTER, not (*y)
}
```

The program prints a garbage integer (e.g. `-1849692656`). Working shapes
(same sweep): `return((y + i32(0)))` → 3, bare tail `y` → 4, `v := y;
return(v)` → 5, and RC-typed `return(r)` returns the pointee copy with
balanced counts. Only the explicit `return(<binding atom>)` shape is broken.

## Root cause

`generate_return` (`src/codegen/exprs/return.yo`) decides the arg is an
`inout` binding by looking the atom's token up in the ARG's recorded
`ExprInfo.env` — and that env does not contain the binding: measured with a
gated probe (`ra_len=0` for the binding, and also for a plain local in the
working control). The identifier evaluator records `source_variable` on every
read (`src/evaluator/exprs/identifer_and_operator.yo:427`) and that stamp
survives, but nothing consulted it on this path. With the env lookup dead,
the two `is_ref` guards in `generate_return` never fire,
`generate_atom`'s `_var_read_code` (same broken env) answers "not a ref",
and the emitter prints the bare C name — the `T*` pointer — where the value
is expected. RC-typed returns were correct only because their deferred-dup
materialization mints a fresh node whose recorded env is right.

## Fix

`generate_return` now (a) treats the arg as a ref atom when the evaluator's
`source_variable` stamp says `is_ref` (the env lookup stays as a fallback),
and (b) in the no-dup branch, rewrites the bare name to `(*name)` when the
stamp says `is_ref` and `generate_atom` emitted the bare name. The dup branch
(RC returns) is untouched. Guarded by an exact `arg_code == <bare name>`
comparison, so a path that already derefs is never double-wrapped.

## Verification

- Probe (failing vs working shapes, `--optimize 2`, 2026-09-23):
  `f1` explicit `return(y)` returned garbage (`-1849692656`) before, `2`
  after; `return((y + i32(0)))` → 3, bare tail `y` → 4, `v := y; return(v)`
  → 5, and RC `return(r)` → pointee copy with `rc() == 1`, all unchanged.
- Emitted C before: `return y;` — after: `return (*y);`.
- Regression test: `tests/ref_local_binding.test.yo` "return through a
  binding copies the pointee (scalar, field, RC)".
- The six inout gating files re-run green through the fixed tree-built
  binary (`ref_local_binding` 16/16, `for_macro_borrow` 26/26,
  `for_macro_borrow_strict` 1/1, `ref_borrow_invalidation` 4/4,
  `ref_field_borrow` 15/15, `ref_params` 8/8).
