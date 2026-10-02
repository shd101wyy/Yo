# Phantom enum positions decided by spelling share one method specialization

**Severity:** S1 — silently wrong results: `sizeof(K)` in a method on `Tag(K)` printed `1 1` for `Tag(u8)` and `Tag(i64)`. This never reached `develop`: it was an intermediate state of the branch that fixed `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`, where the develop-built compiler rejects these programs with E0610.
**Found:** 2026-10-01, adversarial review of that branch.

## Reproducer

```rust
{ println } :: import("std/fmt");
_Discard :: (fn(comptime(X) : Type) -> comptime(Type))(u8);
_PhantomTag :: (fn(comptime(K) : Type) -> comptime(Type))(enum(A, B(n : _Discard(K))));
impl(generic(K : Type), _PhantomTag(K), ksize : (fn(self : Self) -> usize)(sizeof(K)));
main :: (fn() -> unit)({
  println(_PhantomTag(u8).A.ksize());
  println(_PhantomTag(i64).A.ksize());
});
export(main);
```

Expected `1 8`; printed `1 1`. Two other constructor bodies did the same:
`{ _k :: K; enum(A, B(n : u8)) }` (printed `1 1 1` for `u8`, `i64`, `i32`)
and `enum(A, K(n : u8))`, where a variant label spells the parameter.

## Cause

`type_key` keys an enum's phantom type arguments so that `Tag(u8)` and
`Tag(i64)`, whose payloads are identical, are two C types and get two
specializations of every method. That version decided which positions are
phantom from the constructor's source: a parameter was phantom only when no
identifier atom in the body spelled its name. Each body above spells `K`,
so `K` counted as a payload argument and was not keyed. The evaluator still
treated the instantiations as distinct types, but codegen merged them.

## Fix

Phantomness is decided from what the enum depends on. Every type
constructor's definition-time trial already evaluates its body with each
type binder bound to a SomeT. When that body is an enum, a position is
phantom if its SomeT occurs in none of the enum's payloads
(`_record_ctor_phantom_positions`, `src/evaluator/calls/function_type.yo`).
The record is kept per constructor (`register_ctor_phantom_positions`,
`src/types/creators.yo`) and read at the comptime-fn stamp
(`ctor_phantom_flags`). The trial runs before any call can, since a call
needs the definition's value, so every instantiation reads the same record. A
constructor with no record, or a position past it (a variadic argument),
counts as phantom: keying a position the payloads already determine only adds
a redundant key part, while leaving a phantom position unkeyed merges two
types. The spelling scan (`_ctor_body_names`) is gone.

## Verification

`tests/comptime_type_arg_binding.test.yo`, "A parameter the enum's payloads do
not depend on is phantom, however its constructor spells it", covers all three
constructors. The spelling-based build (`3705a7e25`) printed `1 1`, `1 1 1` and
`1 1`. The fixed build prints `1 8`, `1 8 4` and `1 8`.
