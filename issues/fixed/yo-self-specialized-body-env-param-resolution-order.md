# yo-self: specialized-body env resolution can return a caller-module global instead of the parameter

> **FIXED — 2026-08-07.** The "resolution order" framing below was wrong:
> the frame-indexed probe showed BOTH `flag` bindings in the SAME
> (parameters) frame — the innermost match was the specializer's
> parameter RE-BIND (`create_specialized_function_inline` refreshes each
> param's resolved concrete type via plain `add_variable_to_env`), which
> carried `is_parameter = false` and a synthetic caller-module token.
> Resolution was working as designed (innermost wins — the freshest
> parameter binding); the BINDING was mislabeled.
>
> Fix: every binding OF a parameter now carries `is_parameter = true` —
> the checked bind in `check_if_function_parameter_matches_argument`, the
> spec-time re-binds (`_rbc`/`_rb`), the comptime-param value bind
> (`_ectp`), and the closure-wrapper re-eval bind (`_cwp`), all in
> `yo-self/evaluator/calls/helper.yo`. The codegen parameter-shadow guard
> stays as defense-in-depth. Verified: the probe shows `param=true` on
> both bindings; module 13/13, fn 24/24, full gates + FIXPOINT_HOLDS.
>
> Fixing the flag exposed and enabled the SECOND fix in the same commit:
> yo-self never emitted scope-end drops for `own(...)` parameters at all
> (TS begin.ts:1894's parameters-frame pass had no mirror) — the yo-self
> arm of issues/fixed/own-param-discard-leak.md. `evaluate_begin_expression`
> now schedules a params-frame drop pass (params-only gated — a def-time
> body env can carry caller frames below the params frame, and an
> ungated pass scheduled a caller local's drop into the callee:
> the dyn_error_source_default corpus SELF-FAIL). rc trace now matches
> TS (2 -> 1); ref_field_borrow 12/12 under the self-hosted runner; both
> files added to the gates battery so this class is covered.

## Symptom (as observed before the mask)

`std/assert`'s `assert(flag, msg)` is specialized per call site. Inside a
test batch that also declares a module-level global named `flag`, the
specialized body's read of `flag` resolved — via
`get_variables_from_env(env, "flag")` taking the LAST match — to the
**batch module's global**, not the function's own parameter. TS resolves
the parameter (its module suite passes with distinct C names).

This was invisible for as long as both variables emitted the same C name
(`flag`). The moment module globals got module-qualified C names, every
`assert` in the batch tested `flag_m<hash>` (the global, initially
`false`) instead of its parameter — 8 of 13 tests failed while the C
compiled cleanly.

## Root (suspected)

The env built for a call-site specialization's body evaluation appends or
merges CALLER-env frames such that a caller-module global lands AFTER the
parameters frame in `get_variables_from_env`'s result order, so
`variables[len-1]` — TS's "innermost wins" rule — picks the global. TS's
specialization env keeps parameters innermost.

## Current mask

`get_variable_name_for_codegen` never applies the module-global qualifier
when ANY match for the name is a parameter (a same-named parameter
lexically shadows the global, so the bare name in that scope means the
parameter, whose C name is the bare name). This restores correct C for
the parameter reads, but the underlying resolution still returns the
wrong Variable object — any OTHER consumer of the resolved variable
(type, RC flags, is_ref) inside a specialized body with this name shape
gets the global's metadata.

## Repro

Any specialized function with parameter name N called from a module that
declares a module-level runtime global N. Probe
`get_variables_from_env(env, N)` order in the specialized body, or diff
the emitted C name of the parameter read with/without the mask.

## Next step

Find where the specialization body env is assembled
(`create_specialized_function_inline` / the def-time env builder) and
compare frame order with TS's; the fix is to keep the parameters frame
innermost (or filter caller module-globals shadowed by params) at env
construction, then the codegen mask can be retired.
