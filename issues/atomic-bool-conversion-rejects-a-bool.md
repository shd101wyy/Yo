# `atomic_bool(false)` is rejected although a `bool` fills an `atomic_bool` slot

**Severity:** S3 — a valid conversion is rejected with a misleading message ("converts integers, floats, enum discriminants and C-compatible values only"); writing the plain `bool` into the slot is the other spelling
**Found:** 2026-09-29, writing `std/arena.yo` for `plans/EXPLICIT_ALLOCATORS.md` P0.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ atomic_bool } :: import("std/libc/stdatomic");
S :: struct(lock : atomic_bool, n : i32);
main :: (fn() -> unit)({
  s := S(lock : atomic_bool(false), n : i32(1));
});
export(main);
```

```
error: Cannot convert a value of type bool to atomic_bool: `atomic_bool(x)` converts integers, floats, enum discriminants and C-compatible values only
```

`atomic_bool(0)` is accepted, and so is `S(lock : false, ...)`:
`std/sync/atomic.yo`'s `AtomicBool.new` builds its field exactly that way.

## Cause

Two rules disagree. `are_types_compatible` (`src/types/compatibility.yo`)
lets a C scalar, `bool` included, value-initialize an extern-opaque slot
(`ExternOpaqueT`). The explicit conversion `T(x)` goes through
`evaluate_numeric_type_call` (`src/evaluator/calls/numeric_type.yo`), which
treats an extern-opaque target as an integer alias and validates the SOURCE as
numeric, comptime-numeric or an enum. `bool` is none of those, so it is
rejected, even though C casts a `bool` to `atomic_bool` directly.

## Fix

Accept a `bool` source when the target is extern-opaque, the same rule the
implicit coercion applies. A numeric target still rejects `bool`
(`usize(flag)`, `issues/fixed/numeric-conversion-of-a-non-numeric-source-checks-clean-and-emits-a-hollow-stub.md`).
