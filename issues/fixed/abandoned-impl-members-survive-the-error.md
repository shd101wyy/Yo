# Members of an abandoned `impl` block survive its error

**Status: FIXED 2026-09-05** (PR `feat/retire-impl-forward-shells`, plans/reference/LAZY_TOPLEVEL_BINDINGS.md P3).

## Symptom

```rust
Aborted :: struct(n : i32);
comptime_expect_error(
  impl(
    Aborted,
    bad : (fn(self : Aborted) -> i32)(String.from("not an i32")),
    good : (fn(self : Aborted) -> i32)(self.n + i32(1))
  )
);
comptime_expect_error(Aborted(n : i32(1)).good());   // FAILS: `good()` evaluates
```

```
error: Expected compile error, but the expression was evaluated successfully:
(Aborted(n : i32(1)).good)()
```

The impl is abandoned at `bad` (its body has type `String`, the declared result
is `i32`), the error is caught by `comptime_expect_error`, evaluation continues
— and `good`, a member the impl never reached, is callable.

## Root cause (two mechanisms, same hole)

- **Shell design (develop before P3).** Case 3's forward-shell pre-pass
  (`_try_create_forward_shell`) registered a bodiless shell for EVERY
  function-shaped member into the permanent registry before the member loop
  ran, so the members after the throwing one stayed registered as shells that
  nothing ever superseded (and that codegen would have emitted as thunks to a
  redirect that does not exist).
- **Pending-field forcing (P3).** The block's `ImplInFlight` record is pushed
  at entry and popped at the normal end of the member loop. A throw in the
  loop unwinds past the pop; the record stays on `g_impls_in_flight` with
  `good` still `Unforced`, and the later `good()` miss reaches
  `force_in_flight_field`, which finds the stale record and evaluates the
  member with the abandoned block's env. The same throw also strands the
  member's `PendingDef` on the forcing stack.

Only the module walker's abort edge truncated the stacks
(`evaluate_anonymous_module_begin_exprs`). Every other site that catches an
evaluation error and continues — `comptime_expect_error`, the def-time
body-trial swallows (`_trial_eval_fn_body`, `_trial_eval_anon_body`), the
pending-definition forcer, the in-block field forcer, the trait-default
materializer — left whatever the failed evaluation had pushed.

## Fix

`src/evaluator/context.yo`: `ForcingDepths` / `forcing_depths()` /
`truncate_forcing_depths(d)` snapshot and restore the three stacks (module
walks, forcing defs, impls in flight). Every catch-and-continue site takes the
snapshot before its guarded evaluation and truncates back afterwards
(unconditionally — a depth that did not change is a no-op):
`comptime_expect_error.yo`, the three `_trial_eval_fn_body` callers in
`calls/function_type.yo`, the two `_trial_eval_anon_body` callers in
`values/anonymous_function.yo`, `_force_pending_def_impl` and the walker abort
edge in `values/anonymous_module.yo`, `force_in_flight_field` and the
`_materialize_default_body` caller in `values/impl.yo`.

The shell-side variant disappeared with the shells themselves (P3).

## Test

`tests/forward_ref_impl_block.test.yo` test 7 ("members after a failing impl
member do not exist") — the two module-level `comptime_expect_error` above.
