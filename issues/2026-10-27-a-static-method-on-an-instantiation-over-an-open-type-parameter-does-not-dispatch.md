# A static method on an instantiation over an open type parameter does not dispatch

**Severity:** S2 — a valid program is rejected: in a function whose parameter is typed `Impl(...)`, a static method of a generic impl called on a type built from that parameter's type (`_Holder(type_of(f)).make(...)`) is E0610 "No method".

**Status:** open. **Found:** 2026-10-27, by static-argument inference A3 (`feat/sai-a2a3-handle-ctors`): `dyn(f)` for `f : Impl(Fn(...))` synthesized `Rc(Impl(Fn(...))).new(f)`, and every such `dyn(...)` in `tests/dyn.test.yo` failed this way.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
_Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(n : usize));
impl(generic(T : Type), _Holder(T), make : (fn(n : usize) -> Self)(Self(n : n)));
_g :: (fn(f : Impl(Fn(x : i32) -> i32)) -> usize)({
  h := _Holder(type_of(f)).make(usize(3));
  h.n
});
main :: (fn() -> unit)({
  k := i32(1);
  r := _g(x => (x + k));
});
export(main);
```

`yo check` on develop `476cfb700` (and v0.2.70):

```text
error[E0610]: No method "make" on _Holder(Impl(Fn(i32) -> i32)): the type has no field or method with that name.
  --> tmp/opengap.yo:5:27
```

## Root cause (not instrumented further)

`_g`'s body is checked at its definition with `f`'s type the open `Impl(Fn(...))` type variable, and the check is not a definition-time trial. `try_match_generic_impl` (`src/evaluator/values/impl.yo`) matches the receiver `_Holder(SomeT)` against the impl's pattern `_Holder(T)` and binds `T` to that type variable, a different-id SomeT. `_resolve_one_forall_binding_from` accepts such an abstract binding only inside a definition-time trial (`_abstract_bindings_ok`): outside one an abstract match once minted a specialization codegen skipped while the call site still called it (the comment there, `tests/derive_clone_complex.test.yo`). So the impl does not match, and the lookup misses. A generic FUNCTION called with the same type variable (`rc(f)`) binds it and is accepted, which is why `dyn(f)` worked while it synthesized `rc(f)`.

## Workaround in the tree

`dyn(...)` boxes a payload over an open type parameter with the prelude's generic `rc`/`arc`, bound to the callee node by value rather than by name (`_synthesized_cell_call`, `src/evaluator/values/dyn.yo`). Static-argument inference Generation B3 deletes `rc`/`arc` (`plans/backlog/STATIC_ARGUMENT_INFERENCE.md` §5) and needs this fixed first, or a cell constructor the compiler keeps for itself.

## Fix direction

Accept the abstract binding when the receiver's own type argument IS the open type variable the body is checked over (the match then holds for every instantiation), with codegen emitting the specialization the call site names, and test the reproducer above plus `dyn(f)` through `Rc(T).new`.
