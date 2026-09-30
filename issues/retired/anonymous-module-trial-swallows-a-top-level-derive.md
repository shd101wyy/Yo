# The anonymous-module trial can swallow a top-level `derive` entirely

**Severity:** S2 — a failing derive_rule body is swallowed — impl permanently missing while check and compile both exit 0

**Status: RETIRED 2026-09-29 — no longer reproduces; the swallow it describes is gone.**
Re-verified on develop `c52ce152c`, with a tree-built compiler:

- The reproducer's rule no longer FAILS: `to_comptime_string()` on the `.a => \`x\``
  closure's LHS renders `.a` (a rule that embeds it in a derived method prints `.a`
  at runtime). So `check` exiting 0 on it is correct, not a swallow. The
  `[anon-swallow] … __yo_expr_to_string` line quoted below comes from the def-time
  trial of the PRELUDE's own `to_comptime_string` lambda (`std/prelude.yo`, in the
  log before the reproducer's module starts); it was never the derive's error.
- A rule that DOES fail inside an unused `::` binding
  (`s :: pair.get_args().car().no_such_method();`) fails `check` with rc=1 and the
  rule's own message (`derive on "P3": the derive rule failed: No method
  "no_such_method" on Expr …`), pointing at both the binding and the `derive`.
- A derive whose GENERATED impl fails (`derive(P4, Eq(P4))` over a field with no
  `Eq`) fails `check` with rc=1: `derive on "P4" failed: No matching call found for
  operator "==" with receiver type "NoEq"`.

The regression guard is the existing cli case
`tests/cli-cases/check-derive-rule-error-reaches-the-user` (a rule failing inside a
`::` binding must fail `check`). `issues/repros/derive-rule-error-vanishes-entirely.yo`
was removed with this retirement: it no longer exercises a failure.

---

Original report (2026-09-09), kept as the record. Split out of
`issues/fixed/derive-swallows-the-rule-error.md` on 2026-09-09, whose
reproducer 2 is this defect. That issue's own half — `derive` losing the rule's
message because it used the 3-argument `evaluate_expression` — is fixed; this
outer swallow is not.

## Reproducer

`issues/repros/derive-rule-error-vanishes-entirely.yo`: a `derive_rule` whose
body raises inside a `::` binding.

```
$ yo check   issues/repros/derive-rule-error-vanishes-entirely.yo ; echo rc=$?   # rc=0
$ yo compile issues/repros/derive-rule-error-vanishes-entirely.yo ; echo rc=$?   # rc=0
$ YO_DEBUG_SWALLOW=1 yo check … 2>&1 | grep expr_to_string
[anon-swallow] error: Expected expression value for "__yo_expr_to_string" argument
```

The rule really did fail, the `derive` emitted no impl, and **both commands
report success**.

## Root cause

`evaluate_anonymous_module_begin_exprs`
(`src/evaluator/values/anonymous_module.yo`) evaluates each top-level
expression under a swallowing handler — the `[anon-swallow]` channel. That is
right for a *trial*: a form whose evaluation order is not yet settled may
legitimately fail on a first pass and succeed on a later one, which is what
makes order-independent `::` definitions work
(`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`).

It is wrong for `derive`. A `derive(...)` statement exists solely to REGISTER
an impl; there is no later pass that re-runs it, so a swallowed failure is a
permanently missing impl behind a green `check`. The failure mode is the same
class as the hollow-body one the forward-reference diagnostic was added for:
green gates over code that is not there.

## Fix sketch

Either:

1. **Evaluate a top-level `derive` outside the trial** — it is not
   order-sensitive in the way a `::` binding is, since its target type and its
   rule must both already be bound for it to run at all; or
2. **Re-raise when the trial swallowed a `derive`** on the pass that is not a
   trial, the way `_trial_eval_fn_body`'s callers re-raise through
   `_trial_swallow_message()`.

(2) is the smaller change and matches the existing shape. Either way, the test
is the reproducer above: `yo check` on it must exit non-zero and name the real
error.

## Why it is separate

The fixed half was a wrong *choice of evaluator* inside `derive` — one call
site. This half is about which top-level forms the module trial may swallow,
which touches the lazy-bindings design and needs its own decision. Bundling
them would have put a design question inside a one-line bug fix.
