# A throwing overload trial leaves its parameter type in `ctx.expected_type`

**Severity:** S3: latent; reproduced only with R3's first encoding of by-value reference slots (the r3j/r3k builds), where it made `ArrayList(i32).new().clone().into_iter()` fail with `E0601: Cannot unify "ArrayListIter(T)" and "&mut ArrayList(T)"`.

Found 2026-11-11 while integrating R3 with G2's `impl(&C)` / `impl(&mut C)` `IntoIterator`s. Fixed by the same PR as R3 (VERDICTS-54: file as its own issue).

## Root cause

`_select_matching_overload` trial-calls every candidate of a method name. A trial evaluates the receiver as its argument with `ctx.expected_type` set to the candidate's parameter type, and restores it after the argument. A trial that throws in between (a candidate whose slot cannot take the owned temporary) unwinds past the restore, so the next trial, and the real call after the loop, saw `&mut ArrayList(T)` as the type the position expects and failed the result check of the winning candidate.

## Fix

`_select_matching_overload` saves the call's `ctx.expected_type` before the loop and puts it back after each trial, as it already does for `is_in_function_call_checking_phase` for the same reason (the swallow handler unwinds past the helper's own tail). Test: `tests/impl_ref.test.yo` "(R3) an owned temporary receiver picks the by-value impl: `.clone().into_iter()` runs and counts" (it failed on the r3k build; on develop the trial never threw, so it passes there too).
