# A generic fn whose binder is named `T` cannot return `io.async` of a composite over `T`

**Status:** FIXED 2026-09-26 (Phase 3.8 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). **Found:** 2026-09-26, reducing
`issues/a-generic-async-fn-whose-future-result-contains-t-emits-two-c-types.md` to a minimal
program (Phase 3.8 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Severity:** a false type error: a correct program is rejected at the call.
**Reproducer:** `issues/repros/a-caller-binder-named-t-collides-with-io-async-t.yo`

## Symptom

```rust
_wrap :: (fn(generic(T : Type), v : T, io : Io) -> Impl(Future(Option(T), Io)))(
  io.async((io : Io) => Option(T).Some(v))
);
main :: (fn(io : Io) -> unit)({
  r := io.await(_wrap(i32(5), io), io);
  ...
});
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "Option(T)"
 --> 3 |   io.async((io : Io) => Option(T).Some(v))
```

`yo check` of the definition alone passes; the error comes from the call's specialization
(`T := i32`). Renaming the binder to `U` removes the error (and reaches the double-emission bug
instead). So `io.async`'s own `T` resolves, by name, to the caller's `T := i32`.

## Root cause (measured)

A chain-resolution probe (`get_value_of_some_type_from_env`, printing the binder's id, frame level,
the env depth and the last same-named binding) showed `io.async`'s DECLARATION binder `T` (id 2217,
frame level 2) resolving first to `Option(T)`, then to `i32`. It was the same variable both times:
one binding in the call's frame, updated in place.

- With a Future-carrying expected type, Step 6b (`try_to_call_function_with_arguments`) pre-binds
  `io.async`'s `T := Option(T_caller)` with a plain `add_variable_to_env`. The binding carries no
  identity: a binder is looked up by name and confirmed by frame level.
- Synthesis of the caller's own `T := i32` then found that slot by name. `_bind_some_type`'s
  identity gate only protects a slot whose value is still a SomeT, so it overwrote the resolved
  slot in place.
- The closure argument's check then resolved `io.async`'s `T` to `i32`: `_def_frame_confirms_binding`
  accepted the caller's `T` because the two binders share a frame level (a prelude signature and a
  user signature are both at depth 2). Name plus frame level does not identify a binder.

## Fix

A type binding records the id of the binder it resolves (`VariableRare.bound_some_id`,
`variable_bound_some_id`), and the resolver pairs by it:
- `_bind_some_type` records it for a named type parameter (not for `Impl(...)` annotation wrappers
  or nameless dyn wrappers, which synthesis also binds by name), and its identity gate treats a
  slot's recorded id as the slot's identity, so another lineage shadows the slot instead of
  overwriting it.
- Step 6b's pre-bindings record the id of the call's own binder (its self-marker), and the
  "already bound?" check only counts a binding that belongs to this call's binder.
- `_do_chain_resolve` and `_lookup_by_frame` (`src/types/env_lookup.yo`) trust a recorded binding
  only for its own binder, and look past a same-named binding of another binder to the one recorded
  for the SomeT being resolved.
- `io.async`'s per-call binders (`_freshen_io_builtin_callee`) take `UNFRAMED_BINDER_LEVEL`
  (`src/types/creators.yo`): no environment reaches that depth, so they resolve only through their
  own recorded binding.

Two more defects surfaced once the false E0601 was gone, both fixed here:
- `_resolve_some_types_deep` applied `substitute(ns, wrapper)` to the whole wrapper. The
  substitution is keyed by (name, level), and the carriers of `io.async`'s `Impl(Future(T, Io))`
  hold other `Impl` SomeTs at the same level (`Io`'s fields), so the wrapper node itself was
  replaced by the action closure's `fn` type. It now substitutes into the carriers only
  (`_substitute_wrapper_carriers`).
- `_resolve_some_types_deep` registered each carrier binder's env resolution in the global
  id-keyed registry under the binder's DECLARATION id, which every specialization shares. A second
  instantiation read the first one's `U := i32` back. The resolver already returns its answer as a
  value; the global write is gone (plans/TYPE_SYSTEM_SOUNDNESS.md Phase 3.7).

- With that write gone, an unannotated `io.async(e => ...)` lowered `e` to `void*`: the closure's
  result re-registration (`evaluate_anonymous_function_implementation`) rebuilt its type from the
  parameter list captured BEFORE the expected-env substitution, putting `e : E` back, and only the
  registry had been resolving that `E`. It re-registers the substituted parameter types now
  (caught by `tests/impl_fn_field_rejection.test.yo`'s io.async canary).

Regression test: "a future result containing a binder named T" (`tests/async_generic_future_return.test.yo`).
