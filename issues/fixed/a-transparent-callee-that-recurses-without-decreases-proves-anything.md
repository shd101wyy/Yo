# A transparent callee that recursed without `decreases` gave an axiom that proves anything

**Severity:** S1 — the verifier proved a false claim. `liar`'s
`ensures(r == spin(x))` verified with `r = 0` for
`spin :: (fn(x : u32) -> u32)(spin(x) + u32(1))`.

**Status:** FIXED 2026-10-01 (`feat/verifier-distinct`, A3 slice 2 of
`plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md`). Found while reading
`_transparent_call_term` to plan that slice.

## Reproduction

`tests/spec/fixtures/negative/transparent_recursive_false.yo`. Measured with a
compiler built before the fix: `liar` is `ok`, while `spin`'s own task is
`outside-subset` ("recursion (requires decreases(...) in the signature)").

## Cause

A3 slice 1 makes an uncontracted callee transparent: its call is an
uninterpreted function defined by the axiom `forall x. spin(x) == body`. The
axiom's body is walked in the caller's task, with `ctx.func_id` swapped out,
so the self call inside it is not seen as recursion. It went through the
transparent path again and reused the function just declared. Nothing checked
that the definition terminates. `spin(x) == spin(x) + 1` has no model, so
every goal that triggers it is provable. `spin`'s own task did reject the
recursion, but a caller never reads that verdict.

## Fix

`_transparent_call_term` keeps a stack of the transparent definitions being
walked. A call back into one of them is transparent only when the callee has
`decreases(...)`. Its own task then proves the measure drops at each self
call, the rule `ghost_fn`s with `decreases` already follow. Otherwise the
attempt fails, and the caller's subset error names the missing property
("not spec-transparent: it calls itself without decreases(...)").

## Regression test

`tests/internal/verifier_negative.test.yo`, "a recursive transparent callee
needs decreases: is_even unfolds, spin is refused by name".
