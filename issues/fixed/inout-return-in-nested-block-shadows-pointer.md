# `return(m)` of an `inout` parameter inside a nested block emits a self-dereferencing shadow

**Status: FIXED (2026-09-07, `inout` local-bindings PR).** Surfaced by the
Phase B tests of `plans/INOUT_LOCAL_BINDINGS_AUDIT.md`: the first `return`
of an `inout` LOCAL from inside an `if` failed to compile, and the minimal
reproducer showed an `inout` PARAMETER has had the same bug all along.

## Symptom

```rust
first_positive :: (fn(inout(m) : i32) -> i32)({
  if(m > i32(0), {
    return(m);      // <- here
  });
  m = i32(-1);
  m
});
```

emits

```c
static inline int32_t yo_id_9543(int32_t* m) {
  if ((((*m)) > (0))) {
    int32_t m = (*m);   // shadow of the pointer param; `(*m)` is the NEW m
    return m;
  }
  ...
```

and clang rejects it: `error: indirection requires pointer operand ('int32_t'
(aka 'int') invalid)`. In C a declarator is in scope inside its own
initializer, so `int32_t m = (*m);` dereferences the freshly declared `int`.
The top-level tail `m` (the fallthrough) never hit this: the shadow is only
legal C inside a nested block, and `issues/fixed/inout-multi-stmt-body-shadow.md`
fixed the top-level shape years ago via a guard on the deferred-dup return
path only.

## Root cause

`generate_return` (`src/codegen/exprs/return.yo`, the `return_temp_var`
block) materializes the return value into a temp NAMED after the source
variable (`ei.variable_name`) whenever that name differs from the generated
code. For an `is_ref` variable the generated read is `(*m)`, which differs
from `m`, so the temp `int32_t m = (*m);` is declared. The guard that skips
this for `inout` atoms existed only on the deferred-dup path (`:668`,
RC-typed values), not on the plain-value path.

## Fix

The plain-value path now performs the same check: a `return(atom)` whose
env variable `is_ref` (a parameter or a local `inout(name) := place`) gets
no return temp and returns `(*name)` directly.

## Tests

- `tests/ref_params.test.yo` — "returning an inout param from inside a
  nested block".
- `tests/ref_local_binding.test.yo` — "pin is released on break and on early
  return" (the `inout` LOCAL shape that surfaced it).
