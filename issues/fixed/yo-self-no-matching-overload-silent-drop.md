# yo-self: all overload candidates rejected ⇒ statement silently dropped instead of TS's hard error

> **FIXED — 2026-08-07.** The suspected root below was half right: the wall
> was the problem, but no error ever reached it from the RESOLUTION — the
> zero-match path in `_select_matching_overload` falls back to the first
> hit by design ("the real call surfaces the genuine error"), and the real
> call's Step-5b `Value mismatch for parameter "_To"` throw was then
> swallowed by `_trial_eval_fn_body`'s handler (visible under
> `YO_DEBUG_SWALLOW=1`).
>
> Fix (two parts, both in yo-self):
>
> 1. `_select_matching_overload`'s dry-runs now set
>    `is_in_function_call_checking_phase` (TS sets it on every dry-run,
>    function.ts:822-831; the Call-overload loop already did) — restored in
>    the LOOP, not the trial helper, because the swallow handler unwinds
>    past the helper's tail.
> 2. Step 5b (`calls/helper.yo`) flags a rejection that fires OUTSIDE the
>    checking phase on the flow-violation channel before throwing; the
>    def-time caller re-raises it via the real exn
>    (`function_type.yo`'s `flow_violation_pending` re-raise). Skipped in
>    cee propagate mode (the throw itself reaches the
>    `comptime_expect_error` catch) and when a flag is already pending.
>    Sound because yo-self faithfully mirrors `shouldDeferBodyEvaluation`:
>    generic bodies are never def-time evaluated, so a non-checking-phase
>    Step-5b failure is always one TS would report too.
>
> Verified: the repro now hard-errors (rc=1, "No matching call found:
> every overload candidate was rejected … Value mismatch for parameter
> \"\_To\"") where it was rc=0 + 2 FTT markers; overload-heavy suites at
> parity under the fixed stage-1 (prelude 5/5 incl. the new regression
> arm, fn 24/24, imm_string 28/28, comptime 28/28). Regression test:
> tests/prelude.test.yo "try_into to a type with no matching impl is a
> compile error" (cee-based, differential-safe).

Found 2026-08-02 while verifying the `= <value>` assigned-parameter overload
filter port (`issues/retired/handoff-2026-08-02/04-prelude-arm1-VERIFY.md`, correction 1).

## Symptom

When _every_ candidate of an overloaded method is rejected (e.g. by the
assigned-value guard, helper.ts:481-497 / `calls/helper.yo` Step 5b), the two
compilers diverge:

- **TS (ground truth):** hard error —
  `Error: No matching call found … Value mismatch for parameter "_To": Expected: i32 / Got: u8`
- **yo-self (with the guard):** rc=0, the statement is dropped as
  `// Failed to transpile b := ((n.try_into)(u8).unwrap)();`

So the guard converts _silently wrong code_ (pre-guard: first-declared impl
wins) into _silently missing code_. The guard only produces the RIGHT answer
when a right candidate exists.

## Repro

`Num` with only `TryInto(i32)` + `TryInto(i64)` impls (see
`scratchpad/t4/r2.yo`), then ask for a third:

```rust
b := n.try_into(u8).unwrap();   // TS: hard error. yo-self: statement dropped.
```

Same class: generic forwarding `n.try_into(T)` inside
`fn(comptime(T) : Type, …)` — TS hard-errors, yo-self says `evaluator OK`.

## Root (suspected, unconfirmed)

The def-time body-eval swallow (`_trial_eval_fn_body` /
`_evaluate_expression_wrapper` catch-alls) converts the thrown
`Value mismatch for parameter` / no-candidate error into a swallowed def-time
failure, which the batch emitter then renders as an FTT comment instead of
propagating a user-facing error. TS propagates the "No matching call found"
aggregation from its call-resolution loop.

## In-tree impact

Zero today — `try_into` appears only in `std/prelude.yo` and
`tests/prelude.test.yo`, and those calls all have a matching candidate.

## Regression case to add when fixed

`n.try_into(u8)` with only i32/i64 impls must produce a compile error naming
`Value mismatch` / `No matching call`, not rc=0.
