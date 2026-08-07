# yo-self `check` accepts `io.await(fut)` (and any wrong-arity field-fn call) that TS rejects

## Status
OPEN — surfaced 2026-06-17 (Phase-5 async baseline). **Root cause corrected
2026-06-17** after instrumented bisection: this is NOT a missing/over-permissive
arg-count check. The check exists and fires; its error is **swallowed by the
definition-time body-eval trial wrapper**. Diagnostic-completeness divergence,
NOT a miscompilation. Low severity; deferred (see "Decision").

## Symptom
`io.await` is declared (std/prelude.yo:8184) with TWO runtime args (`fut`, `e`):
```rust
await : (fn(forall(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T)
```
Calling it with only `fut` — `io.await(task)` — is rejected by TS
(`Too few arguments for function call: Expected 2, Got 1`) but `yo-self check`
reports `evaluator OK`. yo-self accepts ALL arities (0/1/2/3 args).

The divergence is GENERAL, not io-specific. Minimal non-io, non-generic repro:
```rust
Ops :: object(add : (fn(a : i32, b : i32) -> i32));
use :: (fn(o : Ops) -> i32)({
  x := o.add(i32(1));   // 1 arg, needs 2
  x
});
main :: (fn(io : Io) -> unit)(());
export(main);
```
TS: `Too few arguments… Expected 2, Got 1`. yo-self: `evaluator OK`.

## Root cause (bisected with guarded `panic` instrumentation)
For `o.add(i32(1))` (and `io.await(...)`), evaluation proceeds:
1. `o.add` property-access yields `UnknownVal(Func)` (the field's declared Func
   type) — callee type is correctly resolved.
2. function.yo dispatches to the `_ =>` (UnknownVal-callee) arm, which calls
   `try_to_call_function_with_arguments(None, callee_ty=Func, …)`.
3. That hits the `.Func` arm of helper.yo's `try_to_call…`. Instrumentation
   confirmed: `n_params = 2`, `n_args = 1`, `fn_has_variadic = false`,
   `func_val = None` ⇒ `n_required = 2`. So the count check at
   `helper.yo:~1872` evaluates `(1 < 2) || (1 > 2)` = true and **does** call
   `exn.throw(…"Argument count mismatch"…)`.
4. BUT this runs inside **definition-time function-body evaluation**, whose
   trial wrapper SWALLOWS thrown exceptions (unwinds to `unit` to let the
   bootstrap make progress through patterns it doesn't fully model — see
   `[[yo-self-defeval-wall]]` / `[[yo-self-test-trial-eval-swallow]]`). So
   `check` never surfaces the error and reports OK.

In TS, the equivalent body-eval during `check` PROPAGATES the throw, so `check`
fails. The divergence is purely: yo-self's def-time body-eval swallows; TS's
propagates.

## Why this is low severity
- It does NOT affect codegen of VALID programs — a correct `io.await(task, io)`
  resolves its return type `T` normally; only the *error* on an *invalid* call
  is suppressed.
- It is a `check`-diagnostic completeness gap, not a wrong-codegen bug.

## Decision / next steps
A targeted "make arg-count errors propagate through the trial wrapper" fix is
delicate: prior broad def-eval propagation attempts regressed std 53→3
(`[[yo-self-defeval-wall]]`). Arg-count mismatch is always a genuine error (never
an unmodeled-pattern false positive), so it is in principle safe to propagate,
but doing so cleanly needs the trial wrapper to distinguish error *classes*
(yo-self's `Exception` is a single `dyn(Error)`). That is the same scoped-
propagation problem solved for `comptime_expect_error`
(`[[yo-self-comptime-expect-error-disabled]]`). Fold into the broader def-eval-
propagation faithfulness work rather than band-aiding the count check (which is
correct as-is). Tracked under Phase 5 / post-FSM faithfulness.
