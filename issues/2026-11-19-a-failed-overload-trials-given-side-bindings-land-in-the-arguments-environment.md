# A failed overload trial's given-side bindings land in the argument's environment

**Severity:** S3 — latent: nothing observable leaks through it today. Every given-side binding seen while tracing
`issues/fixed/2026-11-13-a-blanket-hash-impl-over-a-reference-rebinds-a-generic-impls-key-to-a-reference-of-itself.md`
was `K := &K`, which the occurs check now rejects before it is written. No program found since writes a different
junk binding through this path. A regression here would reject valid generic code at check time; it would not
miscompile accepted code silently.

Found 2026-11-19 by the Hash lane while it traced the `K := &K` rebinding.

## Mechanism

`_select_matching_overload` (`src/evaluator/calls/function.yo`) trial-calls every candidate of an instance call through
`_trial_call_overload_candidate` / `_run_overload_trial`, which call `try_to_call_function_with_arguments`
(`src/evaluator/calls/helper.yo`). Inside a definition-time trial, that function isolates the CALLEE side: it builds
`callee_env_m` with `snapshot_env` and pushes a scratch frame. It does not isolate the GIVEN side.

`check_if_function_parameter_matches_argument` (`helper.yo`, Step 6) runs `synthesize_types(&resolved_pt, &callee_env_r,
&arg_type_for_synth, &caller_env_r, …)`. Here `caller_env_r` is `expr_info_adopt_env(&arg_info)`, the environment the
argument was evaluated in, passed raw. When the argument's type is a type variable that is unbound in that environment,
the synthesizer's "given is SomeType" branch (`_synthesize_types_impl`, `src/evaluator/types/synthesizer.yo`) calls
`_bind_some_type(&ge, …)` on it. That includes a generic body's own binder, which is self-bound during its
definition-time trial.

`_bind_some_type` shadows the binding in the top frame when the existing slot lives in an outer frame. It updates the
slot in place when the slot lives in the top frame. Neither write is undone when the trial fails: the trial's handler
unwinds, and only expression metadata and move states are restored. When the argument's environment has the binder's
own frame on top (`_h`'s block body re-entered from a sibling member, `[bind-T] slot_lvl=3 top=3 inplace=true`), the
junk binding becomes durable in the impl's frame. Every later member then reads it.

`try_match_generic_impl` (`src/evaluator/values/impl.yo`) closed the same hole for impl matching: it synthesizes against
a `given_scratch` snapshot. Its comment records the hash_set poisoning that motivated it. Parameter synthesis never got
the same treatment.

## Why the occurs-check fix masks it

The only binding observed through this path was the infinite one: a `&K` slot unified with a place of type `K`.
`_occurs_check` now descends into `Reference`, so that unification throws before `_bind_some_type` runs, and the trial
fails without writing anything. The leak path itself is unchanged. It is only unreached by the shapes known today.

## What a regression would look like

A trial candidate whose slot type is finite but wrong for the argument's type variable writes that type into the
caller's environment. Example: a trait method with `x : i32` tried against an argument of a generic body's type `K`
binds `K := i32`. That write needs no occurs-check failure to happen. The symptom matches the fixed bug: a LATER member
or statement of the same generic body sees its binder as the junk type, either as a type error far from the call (a
member's signature evaluating `ArrayList(Entry(i32))` where `K` was meant) or as a spurious "carries an origin" or
E0601 at a site that never mentions the call. Expect it to be order-dependent (it needs the call before the reader) and
body-shape-dependent (block bodies put the binder's frame on top). It can also make a trial pass by `compat=true`
against the junk binding, so a wrong candidate is selected or E0616 is reported.

## Fix (proposed)

In a trial (`ctx.is_in_function_call_checking_phase`), synthesize against a scratch snapshot of the argument's
environment with a pushed frame, as `try_match_generic_impl` does with `given_scratch`. The real call re-runs the
synthesis, so a trial's given-side bindings carry no information. The test is a trait pair whose same-named methods
take `x : i32` and `x : K` at a generic body's own binder, followed by a member whose signature mentions `K`. It must
check and run.
