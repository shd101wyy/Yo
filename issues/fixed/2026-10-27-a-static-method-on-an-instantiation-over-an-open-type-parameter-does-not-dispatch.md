# A static method on an instantiation over an open type parameter does not dispatch

**Severity:** S2 — a valid program is rejected: in a function whose parameter is typed `Impl(...)`, a static method of a generic impl called on a type built from that parameter's type (`_Holder(type_of(f)).make(...)`) is E0610 "No method".

**Status:** fixed 2026-10-28 on `fix/static-method-open-type-param`. **Found:** 2026-10-27, by static-argument inference A3 (`feat/sai-a2a3-handle-ctors`): `dyn(f)` for `f : Impl(Fn(...))` synthesized `Rc(Impl(Fn(...))).new(f)`, and every such `dyn(...)` in `tests/dyn.test.yo` failed this way.

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

## Root cause

`_g`'s body is checked at its definition with `f`'s type the open `Impl(Fn(...))` type variable, and the check is not a definition-time trial: `should_defer` (`src/evaluator/calls/function_type.yo`) defers only a body whose parameter types contain a codegen type variable, and `type_contains_some_type_for_codegen_param` excludes a Fn- or Future-bounded one, so the body takes the concrete-fn path (`YO_DEBUG_DISPATCH=1` prints `[tm-try] … trial=false` for the `_Holder` match). Every call then specializes `_g` with the closure's own type (one C function per closure). `try_match_generic_impl` (`src/evaluator/values/impl.yo`) matches the receiver `_Holder(SomeT)` against the impl's pattern `_Holder(T)`. `_Holder` mentions `T` in no field, so the binding comes from `type_arguments` (`_bind_forall_from_type_args`, `[bfta] … con_ta=[Impl(Fn(i32) -> i32)]`); for `Rc(T)` likewise. Both channels accept a binding to a different-id type variable only when `_abstract_bindings_ok()`, that is inside a definition-time trial: outside one an abstract match once minted a specialization codegen skipped while the call site still called it (the comment there, `tests/derive_clone_complex.test.yo`). A Future-bounded variable already had its own exception (channel 3, `_is_future_handle_slot`: it is a type in its own right); a Fn-bounded one had none. So `T` stayed unbound (`[tm-end] … all_bound=false`), the impl did not match, and the lookup missed. A generic FUNCTION called with the same type variable (`rc(f)`) binds it and is accepted, which is why `dyn(f)` worked while it synthesized `rc(f)`.

## Fix

`_is_open_fn_param_slot` (`src/evaluator/values/impl.yo`): an unresolved `Impl` annotation wrapper whose required traits include an Fn trait, the type of an `f : Impl(Fn(...))` parameter in its non-deferred body. `_abstract_binding_ok(b)` is `_abstract_bindings_ok() || _is_open_fn_param_slot(b)`, and it replaces `_abstract_bindings_ok()` at the two live different-id acceptance sites: the frame-scoped resolver `_resolve_one_forall_binding_from` (a field mentioning `T`) and `_bind_forall_from_type_args` (a parameter only `type_arguments` carry). Static-argument inference had the same gap one step earlier: `synthesize_impl_binders` dropped every type-variable binding, so the unapplied `Rc.new(f)` (the spelling `yo fix --migrate handle-ctors` writes for `rc(f)`) was E0613 "Cannot infer the type parameter `T`" in the same bodies. It now keeps a binding that `_is_open_fn_param_slot` accepts. Not changed: the nameless `dyn(...)` coercion wrapper and a resolved variable (a closure identity, already bound through its resolution), the unscoped `_resolve_one_forall_binding` (no caller), and the durable assoc-type registration (still skipped only inside a trial).

Codegen needed nothing. The definition-time body of a function with an `Impl(Fn(...))` parameter is not emitted. Each call's specialization re-evaluates it with the closure's type and dispatches concretely, the same way the `rc(f)` definition-time specialization was never emitted.

`dyn(f)` keeps boxing a type-variable payload with the prelude's `rc`/`arc` (`_synthesized_cell_call`, `src/evaluator/values/dyn.yo`). Each call specializes the body with the RESOLVED closure type, and a `Rc(T).new` cell over a resolved variable keeps the variable in its type. Generation B3 has to settle that case when it deletes `rc`/`arc` (`plans/backlog/STATIC_ARGUMENT_INFERENCE.md` §5). The unresolved case no longer blocks it.

## Regression tests

- `tests/impl.test.yo` — "a static method over an Impl(Fn) parameter's type dispatches, per closure": the reproducer (`_OpenHolder`, a phantom parameter), plus `_OpenKeep` (a field mentions the parameter), each called with two closure types, and `_OpenKeep.keep(f, n)` (inferred). E0610 / E0613 before the fix.
- `tests/handle_constructors.test.yo` — "Rc(type_of(f)).new(f) of an Impl(Fn) parameter dispatches, per closure": the shape B3's `dyn(f)` will synthesize, `Rc(type_of(f)).new(f)` wrapped in `Box(type_of(r)).new(r)`, and the unapplied `Rc.new(f)` / `Box.new(r)` / `Arc.new(f)` (a `Send` closure). E0610 / E0613 before the fix.

## Related

- `issues/2026-10-27-an-impl-on-a-compound-instantiation-of-a-phantom-parameter-never-matches.md`: filed in the same run, with a different root cause (`_bind_forall_from_type_args` binds only a bare-forall argument position and never unifies a compound one such as `Option(T)`). Still open.
