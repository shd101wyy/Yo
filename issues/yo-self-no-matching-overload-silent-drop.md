# yo-self: all overload candidates rejected ⇒ statement silently dropped instead of TS's hard error

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
