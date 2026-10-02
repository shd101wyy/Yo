# A compound phantom enum argument reuses the abstract method specialization

**Severity:** S2 — a valid program fails in the C compiler (`call to undeclared function`). This never reached `develop`: it was an intermediate state of the branch that fixed `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`, where the develop-built compiler rejects the program with E0610.
**Found:** 2026-10-01, adversarial review of that branch. The branch's own regression test "A compound phantom argument of an enum reaches the method's generic" failed.

## Reproducer

```rust
{ println } :: import("std/fmt");
_PhantomTag :: (fn(comptime(K) : Type) -> comptime(Type))(enum(A, B(n : u8)));
impl(generic(K : Type), _PhantomTag(K), ksize : (fn(self : Self) -> usize)(sizeof(K)));
_opt_ksize :: (fn(comptime(K) : Type, t : _PhantomTag(Option(K))) -> usize)(t.ksize());
main :: (fn() -> unit)({
  println(_PhantomTag(Option(i64)).A.ksize());
});
export(main);
```

```
error: call to undeclared function 'yo_id_…_rtparam0_enum_…_PhantomTag_r0c58_n1_n_u8_ph_enum_std__prelude_…_n194_value_2692_ret_usize'
```

The direct call in `main` fails only when `_opt_ksize` is also defined.

## Cause

The definition-time trial of `_opt_ksize` specializes `ksize` for the abstract
receiver `_PhantomTag(Option(K))`, a specialization codegen never emits. The
concrete call then looks for a cached specialization, and the cache accepts
the abstract one. `are_types_compatible_exact` treats a type argument that
mentions a SomeT as a wildcard. Its `type_key` guard (`calls/helper.yo`) runs only
when `_collect_type_arg_somes` finds a SomeT among the receiver's type
arguments, or when the receiver is a Struct with type arguments. The
collector pushed a phantom argument only when it was a bare SomeT (`K` of
`Tag(K)`). For `Option(K)` it recursed into `Option(K)`, and that recursion
collects nothing, because `Option`'s `K` lives in a payload.

## Fix

`_collect_type_arg_somes` (`src/evaluator/types/function.yo`) adds every SomeT
of a compound phantom argument. No payload of the enum mentions them, so they
live in its type arguments alone. The cache guard then compares `type_key`s,
which differ (`_ph:` + `Option(K)` against `Option(i64)`), and the call gets
its own specialization.

## Verification

`tests/comptime_type_arg_binding.test.yo`, "A compound phantom argument of an
enum reaches the method's generic". It fails to compile its C with the build
of `3705a7e25` (0 tests ran) and passes with the fix. The reproducer prints `16`.
