# The generic call-time binder binds a `sink` closure argument at a bitwise `fn` type

**Severity:** S2 — a `sink` closure parameter of a generic function whose type mentions the type parameter is never owned by the callee, so a move-only closure that holds a `Dispose` value cannot be moved on inside it (E0901), and ownership of every such closure argument stays with the caller.

**Found:** 2026-10-15, root-causing `issues/fixed/2026-10-15-a-closure-parameter-captured-by-an-inner-closure-is-e0901.md`.
**Status:** open.

## Symptom

```yo
take :: (fn(generic(U : Type), sink(f) : Impl(Fn() -> U)) -> U)(f());
run :: (fn(generic(T : Type), sink(cb) : Impl(Fn() -> T)) -> T)(take(() => cb()));
```

A tree build traced the parameter bindings (temporary `eprintln`s at each
`bind_parameter` site, not committed):

```text
[capbind fv] cb pi=0 own=true n_own=1 bind_ty=fn() -> i32 callee=fn(generic(T) cb : Impl(Fn() -> T)) -> T
[capbind closure-shadow] cb pt=Impl(Fn() -> T)
[capmove] cb … #0 param=true own=false ty=fn() -> i32
[capmove] cb … #1 param=true own=false ty=Impl(Fn() -> T)
```

The declared flag is `own=true`, but the binding comes out non-owning.

## Root cause

- `_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) binds
  a parameter at the ARGUMENT's type (`bind_ty = arg_info.ty`). For a closure
  literal, that type is a plain `fn() -> i32`.
- `bind_parameter` (`src/env.yo`) keeps the declared owning flag only for a
  type that is not bitwise-copyable
  (`is_owning && !type_is_bitwise_copy(bind_ty)`).
- `consume_argument_for_parameter` sees the same bitwise type on the caller's
  side, so the caller keeps and releases its closure temporary.
- The body, however, reads the parameter through the closure-parameter
  shadow, typed `Impl(Fn() -> T)` and resolved to the capture record, which
  may be move-only.
- When `cb`'s type does not mention `T`, the call takes the other binder and
  binds at the declared `Impl(Fn(...))` type, which stays owning.

## Consequence today

- A capture of such a parameter takes its own references (the stopgap in the
  fixed doc above). That is correct for counted captures.
- A closure holding a `Dispose` value cannot be moved on and is E0901, though
  the parameter is `sink`.

## Proposed fix

- When the parameter is `sink` and its resolved declared type is an Fn-trait
  `SomeT`, retype the argument to that type before both
  `consume_argument_for_parameter` and `bind_parameter`. That is what the
  non-generic path does.
- The caller then transfers the argument and the callee owns it.
- Then remove `capture_of_caller_owned_sink_param`.
- This changes the C type of every such parameter in generic code, so it
  needs its own gate: the emitted call shape, the closure tests, and
  `spawn_blocking` under ASan and TSan.
