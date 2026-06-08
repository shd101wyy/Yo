# yo-self: flowability tests fail — flow violations swallowed by def-time trial-eval

## Summary

The 4 flowability tests (`ref_flowability`, `ref_local_binding`,
`ref_closure_capture`, `slice_flowability`) fail under the `is_executing` build.
They are `comptime_expect_error(...)` tests that expect a flow-soundness
VIOLATION to be rejected, but yo-self does NOT reject them ("Expected compile
error, but the expression was evaluated successfully").

**The flowability port itself is NOT the problem.** `is_flowable_expr`
(yo-self/types/flowability.yo, 334 lines) is a complete, faithful port of TS
`isFlowableExpr` (flowability.ts) — verified case-by-case (R1 atom/binding flags,
R2 `.field`, R3 function-call ref-return, R4 cond/match arms, `&+`/`&-`, variant
ctors, slice-flowability options). The bug is that its rejections are
**swallowed**.

## Root cause — the def-time trial-eval swallow hides flow violations

`is_flowable_expr` is invoked at two sites; both throw a rejection that the
def-time body eval swallows:

1. **Return position** (`-> ref(T)` functions, function_type.yo). After
   `_trial_eval_fn_body`, the flow check runs on `flow_out.get(0)` (the
   trial-evaluated final body expr). For a `cond`/`match` body whose
   non-flowable arm fails to unify with the `*(T)` return shape, the body eval
   THROWS (arm type mismatch) and is swallowed → `flow_out` is EMPTY → the flow
   check is skipped (`.None => ()`). FIX (verified working): fall back to the
   raw body `fb` when `flow_out` is empty — `is_flowable_expr` is structural and
   rejects the bad arm. (R3 `returns_value()` already worked: `flow_out` has the
   call, `is_flowable_expr` returns false, the check throws via the outer `exn`.)

2. **Binding site** (`ref(r) := expr` inside a function body,
   initialization_assignment.yo:304). The binding-site flow check throws via the
   threaded `exn` — but DURING def-time body eval that `exn` is
   `_trial_eval_fn_body`'s `inner_exn = Exception(throw : (_err) -> unwind(()))`
   (function_type.yo:199), which SWALLOWS it. So `ref(r) := returns_value()` is
   not rejected.

In TS the def-time body eval PROPAGATES errors, so both violations reject
naturally. yo-self SWALLOWS def-time body-eval errors (the "def-eval wall" — a
deliberate divergence so a file's check doesn't crash on an unported-feature
body in some unrelated function; prior propagating attempts regressed 53→3).
That swallow ALSO eats the deliberate flow-soundness rejections.

## Faithful fix (substantial, risky — focused follow-up)

Two coordinated changes:

- Return position: the `flow_out`-empty → fall-back-to-`fb` fix (low risk, but
  must be sweep-validated against `-> ref(T)` functions whose body eval fails
  for an UNPORTED reason — those would be wrongly rejected).
- Binding site: propagate flow-soundness violations through the trial-eval
  swallow while still swallowing unrelated eval errors. Options: (a) flow checks
  set a distinguished `g_flow_violation` sentinel that `_trial_eval_fn_body`'s
  `inner_exn` re-raises via a captured outer `exn`; (b) message-tag the
  flow-violation errors and re-raise those in `inner_exn`. Both need care to not
  re-raise unrelated swallowed errors.

Gate after: std 151/151, check ./yo-self 228/228, tests should reach 175/182
(closing all 4 flowability tests), leaving 7 (circular_deps ×4,
algebraic_effects, sync/mutex, extern_unsafe_wrap).
