# A `match` or `cond` condition inside `io.async` takes the wrong branch when the branch awaits

**Severity:** S1 — a silent miscompile: inside an `io.async` body, `if(match(...), { …await… })` or `cond(match(...) => { …await… }, …)` always takes the other branch. `yo check` and `yo compile` accept the program.

**Status: FIXED 2026-10-03** (phase A1 of `plans/ASYNC_IO_API_AUDIT.md`, where `std/async`'s `any_first` returned `.None` for a handle that had completed). **Measured on:** the v0.2.49 seed and a tree build of develop `576be6e06`, before the fix.

## Symptom

`issues/repros/a-match-or-cond-condition-inside-io-async-takes-the-wrong-branch.yo`, all inside `io.async` bodies, every expected value `1`:

| Condition | Branch awaits | Before | After |
| --- | --- | --- | --- |
| `match(d, .Some(w) => (w == 0), …)` | no | 1 | 1 |
| `match(d, .Some(_) => true, …)` | yes | **2** | 1 |
| a `bool` function call | yes | 1 | 1 |
| `if(match(...), …)` | yes | **2** | 1 |
| `if(cond(...), …)` | yes | **2** | 1 |
| the same `cond` outside `io.async` | n/a | 1 | 1 |

## Cause

A `match` or `cond` used as a value writes its result temp as a C local. Inside a state machine whose branch awaits, the analysis gives that temp a task slot, and the `if` reads the condition through the slot:

```c
bool _file____User_temp_66007636427892900931;
switch ((sm->var_d_…).tag) { case …SOME: { _file____User_temp_66007636427892900931 = true; … } … }
if (sm->var__file____User_temp_66007636427892900931_14079209058146656016) {   // never written: 0
```

Every call-result temp gets a store into its slot (`_store_temp_var_to_state_machine_if_needed`, `src/codegen/exprs/other_fn_call.yo`), which is why a function-call condition worked. The `cond` and `match` dispatch in `src/codegen/exprs/generation.yo` returned their temp without that step.

## Fix

`_store_result_temp_in_task` (`src/codegen/exprs/generation.yo`) runs the same store after `generate_cond_expression` and `generate_match_expression` when the returned code is the expression's result temp.

## Verification

The reproducer prints 1 for every row. Regression test: "a match or cond condition inside io.async takes the right branch when it awaits" in `tests/async_await.test.yo`, which fails before the fix.
