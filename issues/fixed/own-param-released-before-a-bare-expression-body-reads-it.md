# An `own` parameter is released before a bare-expression body reads it

> Found 2026-09-24: the `rc.test.yo` case "a nested match argument and a match
> moved into an own parameter" (added by #871) went red on every Linux ASan leg
> of develop (`heap-use-after-free … READ of size 4`), because its helper
> `at_sink` is exactly this shape. Fixed in the same PR as this doc.

## Reproduction

```rust
ArgTemp :: ref(struct(n : i32));
at_sink :: (fn(own(a) : ArgTemp) -> i32)(a.n);
```

emitted

```c
static inline int32_t at_sink(ArgTemp* a) {
  __yo_decr_rc((void*)(a));   // frees `a` (the callee owns the only reference)
  return a->n;                // reads freed memory
}
```

Any function whose body is a bare expression (not a `begin`/`{ … }` block)
that takes an `own(...)` RC parameter and whose tail reads it is affected:
`a.n`, `(a.n + i32(1))`, a call taking `a`, and so on. A block body was
already correct (`T __yo_scope_ret = a->n; __yo_decr_rc(a); return __yo_scope_ret;`).
macOS never showed it: the freed 24-byte block still holds the old field value
and ASan does not instrument on the development machine.

## Root cause

`generate_implicit_return_statement` (`src/codegen/exprs/return.yo`), call-tail
branch: the function-scope own-param drops (`only_param_drops`) were flushed
and then `return <rendered tail>;` was emitted, but the rendered tail is an
expression that may still dereference the parameter. The begin-body path has
the B1 materialization (`plans/archive/YO_SELF_RC_EMISSION_LAYER.md` §8) for
exactly this; the bare-expression path did not.

## Fix

When a param-targeted drop is still pending (`has_pending_param_drop`,
`src/codegen/exprs/drop_dup.yo`) and the result is not unit, the tail is
materialized into `__yo_scope_ret` before the drops, then returned.

## Test

`tests/rc.test.yo`: "an own parameter read by a bare-expression body is
released after the read". The assertion is the value read through the freed
parameter plus the Dispose count; on Linux ASan (CI) the unfixed compiler
fails with the heap-use-after-free.
