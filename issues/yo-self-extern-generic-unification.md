# yo-self: generic call-time unification fails on the type-only call path

> **STATUS: fixed** (three coordinated faithful-port fixes, see below).
> Verification: the module-level extern-generic probe flips to pass, and the
> per-prelude-load noise print `Expected *(T) / Got *(u8)` (prelude.yo:5832)
> disappears — `str.from_raw_parts`'s def-eval now unifies.

## Symptom

Calling a generic function that has **no FuncVal body** (extern-declared, e.g.
every `__yo_*` builtin) with a concrete argument failed to unify the forall
type variable:

```rust
extern("C", zext_id : (fn(forall(T : Type), zx : T) -> T));
zr := unsafe(zext_id(u8(7)));
// TS: passes (T := u8)
// yo-self: "Type mismatch for parameter zx: Expected T, Got u8"  (module level!)
```

The head example in the wild: `str.from_raw_parts`'s body
`__yo_slice_new(ptr, length)` — `*(u8)` vs `forall(T) ptr : *(T)` — failed on
every prelude load during def-time body eval (printed by the non-raw wrapper,
then swallowed). This is the head of the ~70-category "unification" def-eval
swallow family.

## Root cause — three stacked gaps vs TS

**The structural root**: TS builds the callee env as
`pushEnvFrame(functionType.env)` (helper.ts:1009) — it **extends the
function type's definition env**, whose forall frame still holds the
self-binding `T := SomeT(T)` created at function-type evaluation. yo-self's
flattened `Func` TypeValue carries no definition env, so
`try_to_call_function_with_arguments` builds `callee_env` **fresh** and that
marker never exists. Three consequences, each fixed:

1. **Missing self-bound marker** (`calls/helper.yo`, Step 6): TS resolution
   (`getValueOfSomeTypeFromEnv`, env-lookup.ts:141-167) accepts a concrete
   binding only after confirming ownership — by finding the SomeType
   self-binding somewhere in the env (`thisSomeTypeWasBound`). In TS there are
   TWO variables per forall param at call time: the def-env marker (intact)
   and the call-frame binding (updated to concrete by `synthesizeTypes`).
   yo-self had only the call-frame one — after `_bind_some_type`'s in-place
   update, `_was_self_bound` found nothing → the fresh binding was DISCARDED
   (returned as unbound). **Fix**: Step 6 recreates the marker — it extracts
   the forall label's SomeT from the parameter/return types and self-binds it
   beneath the `UnknownVal` call binding.

2. **No structural resolution in `evaluate_function_parameter_type_again`**
   (`evaluator/types/function.yo`): it was a bare
   `get_value_of_some_type_from_env`, which is a **no-op for non-SomeT
   types** — `*(T)` came back unchanged. TS re-evaluates the parameter's type
   EXPRESSION in the callee env, resolving variables at any nesting depth.
   **Fix**: `_resolve_some_types_deep` — collect the SomeTs inside the type
   (`get_all_some_types`, deep), env-resolve each, `substitute` the resolved
   ones. Also applied to `evaluate_function_return_type_again`.

3. **Missing TS fallback in chain resolution** (`types/env_lookup.yo`): TS's
   `getValueOfSomeTypeFromEnv` has a definitionFrameLevel fallback
   (env-lookup.ts:170-200) for the case where synthesize REPLACED the
   self-binding with a concrete type. Ported as
   `_def_frame_confirms_binding` (rendered-type equality stands in for TS
   object identity).

## Why the FuncVal path didn't show this

A user-defined generic (`zgen :: (fn(forall(T), zp : *(T)) -> unit)(...)`)
called the same way passed — FuncVal calls go through
specialization/CTFE paths that bind foralls differently. Only the type-only
path (extern builtins; any `functionToCall.value == undefined` call) hit the
bare Step-6/synthesize/re-eval chain.

## Regression guard

A dedicated test is NOT addable today: the failing shape needs a direct
extern-generic call visible to the checker — prelude `__yo_*` externs are not
importable from user modules (TS: "Variable \_\_yo_slice_new not found"), a
user-declared `extern("C")` generic has no C symbol so a `.test.yo` would
fail to link under the TS test runner, and routing through a prelude wrapper
(`"abc".ptr()`) does not discriminate (the wrapper's body — where the
extern-generic call lives — is not evaluated at call time under check;
verified pre-fix exit 0). The effective guards are (a) the prelude-load noise
print `Expected *(T) / Got *(u8)` reappearing in any `check` stderr, and
(b) the def-eval un-swallow milestone, after which `str.from_raw_parts`'s
def-eval failure would fail `check ./std` outright.

## How it was found

Bisected from the `__derive_eq` reflection chain (after the TypeUni-id +
generic-impl specialization fixes landed): the chain's `.get` then failed with
`Expected ComptimeList(T)`, whose minimal extern repro was built and compared
against TS at module level (where errors are not swallowed by the def-eval
trial wrapper). The first fix attempt (fallback #3 alone) was a measured
no-op — the frame levels recorded in SomeTs are meaningless in a freshly-built
callee env; reading TS helper.ts:1009 revealed the two-variable structure that
fix #1 mirrors.
