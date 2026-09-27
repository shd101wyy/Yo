# The closure-body re-raise is blocked: it cannot tell a type error from a value-dependence error

**Status:** FIXED 2026-09-27 (branch `tss/p6-closure-reraise-v2`: a `comptime(x)` parameter makes the body call-dependent)
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

**Root cause:** the gate's notion of "concrete parameters" looked only at SomeTs and forall
binders. `to_comptime_string`'s trait member is `fn(comptime(self) : Self) -> comptime(comptime_str)`
(`std/prelude.yo`), so `self` is a COMPTIME VALUE parameter: its value arrives with the call, and a
definition-time trial has none. The named-fn path already defers on exactly this
(`ft_has_ct_param` in `calls/function_type.yo`, from `get_func_param_comptime`, not counting a
`comptime(T) : Type` binder).

**Fix:** `body_params_concrete` (`values/anonymous_function.yo`) is false when any parameter is
a comptime value parameter, read from the same side table (`get_func_param_comptime`, re-keyed
onto the closure's id by `copy_func_param_comptime` a few lines earlier).

**Superseded first attempt (2026-09-27, PR #962):** a new code E1104 (`E_COMPTIME_EXPRESSION_VALUE`)
on the seven "Expected expression value" raise sites in `builtins/expr_fns.yo`, which the gate
skipped. It classified the symptom rather than the cause (any other error inside such a body
would still have been re-raised wrongly), it dropped the builtin names from the seven messages, and
the commit that removed its `yo explain` entry also deleted E0607's. It was reverted in full.
