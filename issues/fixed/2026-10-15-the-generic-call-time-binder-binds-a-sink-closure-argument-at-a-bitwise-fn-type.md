# The generic call-time binder binds a `sink` closure argument at a bitwise `fn` type

**Severity:** S2 — a `sink` closure parameter of a generic function whose type mentions the type parameter is never owned by the callee, so a move-only closure that holds a `Dispose` value cannot be moved on inside it (E0901), and ownership of every such closure argument stays with the caller.

**Found:** 2026-10-15, root-causing `issues/fixed/2026-10-15-a-closure-parameter-captured-by-an-inner-closure-is-e0901.md`.
**Status:** FIXED 2026-10-17 (`fix/generic-binder-sink-closure-fn-type`).

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

- The inline FuncVal arm of `_evaluate_function_call_unanchored`
  (`src/evaluator/calls/function.yo`, the arm that hands over to
  `_evaluate_funcval_runtime_call`) binds a parameter at the ARGUMENT's type
  (`bind_ty = arg_info.ty`). A parameter whose type mentions the type
  parameter defers its closure-literal argument
  (`fn_literal_arg_is_deferred`), and the deferred literal is typed as a plain
  `fn() -> i32`, with its capture struct on the side
  (`expr_info_capture_type`).
- `bind_parameter` (`src/env.yo`) keeps the declared owning flag only for a
  type that is not bitwise-copyable
  (`is_owning && !type_is_bitwise_copy(bind_ty)`).
- `consume_argument_for_parameter` sees the same bitwise type on the caller's
  side, so the caller keeps and releases its closure temporary.
- The body, however, reads the parameter through the closure-parameter
  shadow, typed `Impl(Fn() -> T)` and resolved to the capture record, which
  may be move-only.
- When `cb`'s type does not mention `T`, the literal is not deferred: it is
  checked against the parameter's `Impl(Fn(...))` type
  (`try_to_implement_closure_by_fn_module_type`) and typed as that wrapper
  resolved to its capture struct. That type is not bitwise-copyable, so the
  caller transfers the closure and the binding stays owning. A named closure
  local carries the same type, so `run(c)` was owned by the callee too: only
  the deferred literal was caller-owned.
- The defect is not specific to `sink`. Since decision 30 a plain by-value
  parameter is owning too, and `cb : Impl(Fn() -> T)` without `sink` failed
  the same way, while its non-generic twin was accepted.

## Consequence today

- A capture of such a parameter takes its own references (the stopgap in the
  fixed doc above). That is correct for counted captures.
- A closure holding a `Dispose` value cannot be moved on and is E0901, though
  the parameter is `sink`.

## Proposed fix (as filed)

- When the parameter is `sink` and its resolved declared type is an Fn-trait
  `SomeT`, retype the argument to that type before both
  `consume_argument_for_parameter` and `bind_parameter`. That is what the
  non-generic path does.
- The caller then transfers the argument and the callee owns it.
- Then remove `capture_of_caller_owned_sink_param`.
- This changes the C type of every such parameter in generic code, so it
  needs its own gate: the emitted call shape, the closure tests, and
  `spawn_blocking` under ASan and TSan.

## Fix

- `_fv_closure_argument_owned_type` (`src/evaluator/calls/function.yo`) names
  the type that decides who owns such an argument: its capture struct. It
  applies when the parameter is by value (`sink` or plain, neither `&mut` nor
  comptime), its declared type carries an `Fn` trait, the argument is typed as
  a bare `fn(...)`, and the capture struct is not bitwise-copyable.
- In the argument loop, the argument's ExprInfo is retyped to the capture
  struct for `consume_argument_for_parameter` only, because the rule re-reads
  the type from the recorded ExprInfo (`set_expr_as_consumed`,
  `set_expr_as_needs_to_call_dup`). The type is restored right after, so the
  generic inference that follows still reads `fn() -> i32`. The caller now
  transfers its closure temporary and no longer releases it.
- The bind loop binds those parameters (and only those) at the capture
  struct, so `bind_parameter` keeps the owning flag. The callee releases the
  closure at scope end, or moves it on.
- A closure whose captures are all plain data stays bitwise-copyable and
  keeps today's code, and so does every argument whose type is already the
  `Impl(Fn)` wrapper. The specialization's C parameter type was already the
  capture struct (`arg_ty_spec`), so no C type changes: only which side
  releases the closure.
- The filed proposal retyped to the declared `Impl(Fn() -> T)` and only for
  `sink`. The plain by-value shape needs it too, and the transfer rule's own
  helpers read the recorded type, so the capture struct (the concrete type,
  which `t_with_resolution` would only wrap) is what both sides use.
- `capture_of_caller_owned_sink_param` (`src/evaluator/utils.yo`) is removed,
  with its clause in `generate_captured_variable_dup_expressions`: no
  parameter is caller-owned at a bitwise type while its capture record is
  move-only any more.

## Verification

VERIFICATION_PLACEHOLDER
