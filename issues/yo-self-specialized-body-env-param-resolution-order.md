# yo-self: specialized-body env resolution can return a caller-module global instead of the parameter

**Found 2026-08-07** while fixing
`issues/fixed/module-global-c-names-are-not-namespaced.md`. Currently
**masked** by the parameter-shadow guard in
`yo-self/codegen/utils/index.yo` `get_variable_name_for_codegen`; filed
because the underlying resolution divergence from TS is real.

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
