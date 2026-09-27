# The closure-body re-raise is blocked: it cannot tell a type error from a value-dependence error

**Status:** FIXED 2026-09-27 (branch `tss/p6-closure-reraise`; E1104 + gate exclusion)
**Found:** 2026-09-27, building the branch for the first time (written unbuilt).

## Symptom

The branch re-raises a swallowed error when a closure's parameters are all
concrete (`body_params_concrete`) and its body produced nothing. First build:
`yo check ./std` fails at

```
error: Expected expression value for "__yo_expr_to_string" argument
    --> std/prelude.yo:7480:55
7480 |     to_comptime_string : (self -> __yo_expr_to_string(self))
```

`to_comptime_string` is a `->` literal whose single parameter `self` LOOKS
concrete (inferred, no SomeT), but its body needs `self`'s VALUE — which only
a call supplies. The def-time swallow of that error is legitimate, exactly the
false-positive class the handover predicted ("a closure whose parameter looked
concrete but whose body still depends on something only a call resolves").

## What a fix needs

The gate must re-raise only errors a call can never fix: TYPE errors. The
clean route is an error code for the value-dependence family ("Expected
expression value for X argument" and siblings), raised `with_code` at their
sites, so the gate can exclude that family the way the named-fn channel
excludes SomeT-pending deferrals — not by matching message text (the
substring-matching anti-pattern `diagnostic-codes-are-assigned-by-substring-matching`
removed). With the gate excluding them, the remaining std/src/fast-suite
fallout is the real latent errors the branch exists to surface, each to be
triaged per the census workflow (positioned `[anon-swallow]` first).

The branch also carries: `g_anon_swallow_diags` (the structured twin of the
text channel), two CLI cases whose goldens are NOT yet recorded
(`check-closure-body-type-error-is-reported`,
`check-ctl-handler-return-type-error-is-reported`), and the
`YO_DEBUG_SWALLOW` `[reeval-swallow]` census trace. All written, none built
green.

## Resolution

**Fixed 2026-09-27, same branch**: the value-dependence family got its own
code — `E1104` (`E_COMPTIME_EXPRESSION_VALUE`, `src/diagnostics.yo`), carried
`with_code` by the seven raise sites in `src/evaluator/builtins/expr_fns.yo`
("Expected expression value for an AST builtin argument"), with a bilingual
`yo explain` registry entry. The closure-body gate skips a swallowed error
whose code is E1104: a call can supply the value, so it is not a type error.

With the exclusion: `yo check ./std` 176/176 and `yo check ./src` 279/279
(the prelude's `to_comptime_string : (self -> __yo_expr_to_string(self))` and
every other value-dependent body defer as before), while both CLI fixtures
(`check-closure-body-type-error-is-reported`,
`check-ctl-handler-return-type-error-is-reported`) still report E0601 at the
closure at check time — the re-raise's whole point.
