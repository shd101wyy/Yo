# A container of a closure type (`ArrayList(typeof(k))`) does not compile

**Found:** 2026-09-25, writing the rule-D9 canary for `^` over a list of closures.
**Status:** FIXED 2026-09-25 (pending verification). Was: OPEN. **Class:** valid code rejected (the evaluator's
generic-impl match; clang or `E0610` downstream).

## Repro

`issues/repros/a-container-of-a-closure-type-does-not-compile.yo`: a closure
`(k : Impl(Fn() -> unit)) = (() => { println("ran"); })`, then
`ks := ArrayList(typeof(k)).new(); ks.push(k)`, then get and call.

- **v0.2.42 seed:**
  `error[E0610]: No matching call found with arguments: (base.add)(i)` in
  `std/collections/array_list.yo:915` (the cycle tracer's `tracer.visit(base.add(i))`).
- **Tree (`ps/phase6-runtime`):** `yo check` passes, and clang rejects the emitted C
  with `incompatible pointer types returning '__yo_t_412997039185314103 *' from a function with
  result type '__yo_t_12991328949723564729 *'`: two C types for `ArrayList(<k's Impl>)`. A
  closure that captures a reference-typed value pulls in the tracer impl and gets the seed's
  `E0610` instead.

The smallest shape needs no `ArrayList`: any generic with a static `-> Self` constructor,
instantiated at a closure's type.

```rust
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(items : i32, _f : Option(T)));
impl(generic(T : Type), Holder(T), make : (fn(n : i32) -> Self)(Self(items : n, _f : .None)));
// ...
(k : Impl(Fn() -> unit)) = (() => { println("ran"); });
ks := Holder(typeof(k)).make(i32(4));   // clang: returning Holder#1 from a fn returning Holder#2
```

Direct construction, `Holder(typeof(k))(items : i32(3), _f : .None)`, compiled. So did methods
taking `self`. Only a method that re-evaluates `Self` (or `Holder(T)`) failed.

## Mechanism

`typeof(k)` is k's annotation wrapper: a SomeT named `Impl` whose resolution cell holds the
closure's capture struct. `type_key` keys `Holder(<that SomeT>)` by the wrapper itself
(`_tk_resolve_arg_slot` deliberately does not hop `Impl`/nameless wrappers: the dyn/box
machinery lowers them to their own C struct).

Matching the receiver against `impl(generic(T : Type), Holder(T), ...)` bound `T` to something
else:

1. Field synthesis bound `T := <k's Impl SomeT>`. `_resolve_one_forall_binding_from`
   (`src/evaluator/values/impl.yo`) discards every SomeT binding outside a definition-time trial
   as "still abstract".
2. The type-argument fallback `_bind_forall_from_type_args` then walked the SomeT's resolution
   cell to the capture struct and bound `T := <capture struct>`.

The specialization re-evaluated its `-> Self` return as `Holder(<capture struct>)`, a second
instance with a second C type. The body built the receiver's `Holder(<k's Impl>)`. For the
tracer, `base : *(<k's Impl>)` and the pointer impl's `*(T)` match rejected
`T := <k's Impl>` at step 1 and had no type arguments to fall back on: `E0610`.

## Fix

A resolved closure identity is a binding, not a type variable:

- `_resolve_one_forall_binding_from` accepts an `Impl` or nameless SomeT whose resolution chain
  reaches a concrete type (`_is_bound_closure_identity`).
- `_bind_forall_from_type_args` binds what the receiver is keyed by. That is the wrapper when
  `type_key` keeps the slot's own identity, and the concrete type when `type_key` hops the chain
  (where-clause foralls and `__impl_fn`, the closure-F combinators, unchanged).

## Regression tests

- `tests/closure.test.yo`: "a container of a closure type compiles and calls the closure"
  (an `ArrayList` of a capturing closure) and "a generic's static -> Self constructor at a closure
  type". Both batches failed to compile before the fix.
- `tests/parallelism_soundness.test.yo`: the D9 canary's sixth route, an `Iso` over a list of
  clean closures run on a thread.
