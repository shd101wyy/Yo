# A container of a closure type (`ArrayList(typeof(k))`) does not compile

**Found:** 2026-09-25, writing the rule-D9 canary for `^` over a list of closures.
**Status:** FIXED 2026-09-25. Was: OPEN. **Class:** valid code rejected (clang or `E0610`), and a
type-soundness hole: `check` accepted pushing one closure into another closure's list.

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
closure's capture struct. The wrapper is copied under fresh SomeT ids as the value flows (into a
parameter, into a specialization's environment). Four places disagreed about what such a wrapper
is:

1. **`type_key`** keyed it by its SomeT id: in a type-argument slot (`_tk_resolve_arg_slot`
   hopped where-clause foralls and `__impl_fn`, but not `Impl` wrappers) and at the top level.
   `ArrayList(<copy 1>)` and `ArrayList(<copy 2>)` of one closure were two C types
   (`__yo_t_412997…` vs `__yo_t_12991…`, and two `Option(<k's Impl>)` with identical layouts).
2. **Identity and flow** (`src/types/compatibility.yo`) called two SomeTs one type when name
   and frame level agree. Every closure's wrapper is named `Impl`. So the CTFE memo handed
   `ArrayList(typeof(k2))` the instance of `ArrayList(typeof(k1))`: valid code failed with
   "Cannot unify incompatible struct types", and `l1.push(k2)` type-checked.
3. **The generic-impl match** (`src/evaluator/values/impl.yo`) discarded `T := <k's Impl>` from
   field synthesis as "still abstract", then bound `T` to the capture struct through the
   type-argument fallback. A static method's `-> Self` then named `Holder(<capture>)`, while
   its body built the receiver `Holder(<k's Impl>)`. For a pointer (`*(T)` in the cycle
   tracer's `base.add(i)`) there was no fallback at all: `E0610`.
4. **Generic calls.** `_resolve_some_types_deep` substituted a nested `T` (`*(T)`) only with a
   non-SomeT binding, so `GcTracer.visit(slot : *(T))` kept `*(T)`. The synthesizer's
   both-SomeT case treated `T := <k1's Impl>` as unbound and rebound it to `<k2's Impl>`.
5. **The synthesizer's env.** Unifying `value : T` with a closure's wrapper wrote the wrapper into
   the caller's env as a type variable. The env is keyed by name, and every closure's wrapper is
   named `Impl`. So after `l1.push(k1)`, the lookup of any later closure's wrapper found k1's
   capture struct: `l2.push(k2)`, for a k2 with other captures, failed with "Cannot unify
   incompatible struct types" at `k2`.

## Fix

One rule: a **closure identity** (`is_bound_closure_identity`, `src/types/utils.yo`) is a
resolved, non-`Future` annotation wrapper, and it *is* its resolution. Codegen already lowered it
to the capture struct's C type. The dyn-coercion wrappers (nameless) keep their own identity,
because the dyn/box pipeline lowers them to a fat call/data struct. So do `Future` wrappers,
because an extern future lowers to a pointer.

- `type_key` keys a closure identity as its resolution, in argument slots and at the top level.
  `helper.yo`'s `_spec_resolve_slot_cell`, a line-for-line copy of `_tk_resolve_arg_slot`, now
  delegates to it.
- Identity and flow compare two closure identities by their resolutions
  (`plans/reference/TYPE_IDENTITY.md` records the rule).
- The impl match accepts a closure identity as a binding. The type-argument fallback binds what
  the receiver is keyed by.
- `_resolve_some_types_deep` substitutes a nested closure identity. The synthesizer treats one
  as bound and unifies two through their resolutions, so `l1.push(k2)` fails at the argument.
  A closure identity's value is its own cell: the synthesizer neither reads it from the env nor
  binds it there, and unifies it with the other side through its capture struct.
- The chain walk `resolve_cell_chain` moved from `compatibility.yo` to `types/utils.yo` and is
  shared.

What the rule touched on the way:

- **An extern opaque type is concrete.** A closure capturing an `AtomicI32` carries the extern
  `atomic_int` SomeT in its capture struct. The identity predicate accepts it
  (`type_has_no_open_some`). `validate_function_return_type` no longer asks a module to "infer" it.
  `typed_ptr.add(...)` inside `array_list.yo` returned it and failed with "Failed to infer the
  function call return type".
- **Rule D9 sees the closure behind its capture struct.** Identity makes a closure identity and
  its capture struct one type, so either can reach a type argument. A capture-free closure's
  struct has no fields, and judged as a struct it is `Send` whatever its code reaches.
  `record_closure_capture_verdicts` now records capture struct → closure fids
  (`g_closure_fids_by_capture`). `function_value_marker` judges a capture struct, or any copy of a
  wrapper, through that registry. The Iso D9 walk treats a capture struct as a function value.
  The impl match binds the closure identity itself, not its capture struct.
- **The cycle analysis follows a closure identity** (`_type_refs_back_to_cyclic`): `^` over a list
  of clean closures judged the element as an arbitrary SomeT, "may form a cycle".
- **The `Impl(...)` reassignment rule runs before the compatibility check**
  (`src/evaluator/exprs/assignment.yo`). Reassigning a closure variable to another closure now
  fails compatibility too, and the rule is the error that explains why.

## Regression tests

- `tests/closure.test.yo`:
  - "a container of a closure type compiles and calls the closure", an `ArrayList` of a
    capturing closure;
  - "a generic's static -> Self constructor at a closure type";
  - "two closures' lists are two types, one per closure";
  - "a second closure's list after the first list's push", closures of different capture shapes.

  All four failed before the fix.
- `tests/parallelism_soundness.test.yo`: the D9 canary's sixth route, an `Iso` over a list of
  clean closures run on a thread.
- `tests/cli-cases/check-closure-pushed-into-another-closures-list`: `check` rejects
  `l1.push(k2)` at the argument. It passed `check` before.
