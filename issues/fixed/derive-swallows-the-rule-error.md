# `derive` discards a rule's own error — and sometimes discards the whole failure

**Status: FIXED 2026-09-09** (`src/evaluator/builtins/derive.yo`). Found the
same day while writing `derive(Error)` (D15) in `std/error.yo`.

**The fix.** The rule call now goes through `_derive_eval_guarded` — the
guarded evaluator that already existed in this file for the generated
`impl(...)` — so the rule's exception is caught, its message parked in the
module-level box, and re-raised through `derive`'s real `exn` anchored at the
`derive(...)` statement. `_derive_eval_impl` was renamed to
`_derive_eval_guarded` (its body was already generic) and its doc now states
the rule: **no derive-internal evaluation may use the 3-argument
`evaluate_expression`.** The two generic messages survive only for a rule that
returns without throwing and still leaves no comptime value, and now say
exactly that.

Pinned by `tests/cli-cases/check-derive-rule-error-reaches-the-user`, which
runs `yo check` on a rule that asserts and matches the rule's OWN text.
`comptime_expect_error` cannot cover it: it only checks that *something* threw,
never which message.

A `derive_rule` function is ordinary comptime Yo. It can validate its
`trait_params` and raise a precise `comptime_assert` naming the offending
variant. **None of that reaches the user.** Depending on where in the rule the
error is raised, `derive` reports one of two things, and neither of them is the
rule's message:

| where the rule fails | what the user sees |
| --- | --- |
| in the result position | `error: derive: derive rule function failed` |
| in a `::` binding in the body | **nothing at all** — `check` and `compile` both exit 0 |

The second row is the serious one: a `derive` that produced no impl reports
success.

## Reproducer 1 — the message is replaced

`issues/repros/derive-rule-error-is-swallowed.yo`:

```rust
_rule :: (
  fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr))
    -> comptime(Expr)
)({
  __why :: comptime_assert(false, "the rule's OWN diagnosis, naming the exact variant");
  quote(())
});
derive_rule(MyRule, _rule);
P :: struct(a : u8);
derive(P, MyRule());
```

Expected: `the rule's OWN diagnosis, naming the exact variant`, at the
`comptime_assert`. Actual:

```
error: derive: derive rule function failed
   --> tmp/probe_swallow.yo:15:11
   |
15 | derive(P, MyRule());
   |           ^^^^^^
```

## Reproducer 2 — the failure vanishes

`issues/repros/derive-rule-error-vanishes-entirely.yo`: the same rule, but the
failing call sits in a `::` binding rather than in the result position.

```rust
_rule2 :: ( … )({
  pair :: trait_params.car();
  s :: pair.get_args().car().to_comptime_string();   // <-- raises
  quote(())
});
derive(P2, MyRule2(.a => `x`));
```

```
$ yo check   issues/repros/derive-rule-error-vanishes-entirely.yo   ; echo rc=$?   # rc=0
$ yo compile issues/repros/derive-rule-error-vanishes-entirely.yo   ; echo rc=$?   # rc=0
$ YO_DEBUG_SWALLOW=1 yo check … 2>&1 | grep expr_to_string
[anon-swallow] error: Expected expression value for "__yo_expr_to_string" argument
```

The rule really did fail — `YO_DEBUG_SWALLOW=1` shows the error — and the
derive emitted nothing, yet both commands report success.

## Root cause

`evaluate_derive` (`src/evaluator/builtins/derive.yo`) invokes the rule by
building a call expression and evaluating it, then reads the RESULT OUT OF THE
EXPR-INFO TABLE rather than out of the call:

```rust
// 7. Call the rule via a generated call expression.
call_code := `${rule_fn_name}(${type_var}, ${ctx_var}, ${tps_var})`;
call_result := evaluate_expression(generate_expr_from_code(call_code, exn), caller_env, ctx);
call_info := match(expr_info_table_get(ctx.expr_info_table, ast_expr_id(call_result)),
  .Some(i) => i, .None => new_expr_info(caller_env, t_unit()));
call_val := match(call_info.value, .Some(v) => v, .None => {
  exn.throw(dyn(format_error_message(tok, String.from("derive: derive rule function failed"))));
  EvalValue.UnitVal
});
```

So `derive` never observes the rule's exception. **The swallow is not one of
the trial handlers** — `YO_DEBUG_SWALLOW=1` prints no `[swallow]` line for it,
which is what made this hard to find. It is the 3-argument
`evaluate_expression` itself: that name resolves to
`_evaluate_expression_wrapper` (`src/evaluator/exprs/_expr.yo:1132`), whose
handler swallows EVERY throw and returns `make_err_expr()`. Any caller in the
evaluator that reaches for the 3-argument form silently loses errors. `derive`
then sees a MISSING VALUE and manufactures a generic message from it.

When the swallow happens further out instead — at the anonymous-module
begin-expr level, `[anon-swallow]` — the `derive` statement itself is abandoned
and nothing is reported at all.

The sibling message at `derive.yo:293`
(`derive rule must return(comptime(Expr)); got ${…}`) is the same defect in a
third dress, and has already masked two unrelated bugs:
`issues/fixed/comptime-str-to-expr-cannot-parse-a-template-literal.md` and
`issues/fixed/evaluator-deadline-error-swallowed-by-trial-eval.md`. Both took a
`YO_DEBUG_SWALLOW=1` run to diagnose, because the printed message pointed away
from the fault.

## Cost paid so far

`derive(Error)` was designed for KEYED messages — write
`.NotFound => …` in any order and have the rule find the pair whose head
matches each variant. Every piece of that works in isolation (`Expr` equality
via `ComptimeEq`, `get_args()`, the fold), but composing them inside a rule hits
reproducer 2's shape, and with the error invisible there is nothing to debug.
The shipped rule therefore requires DECLARATION ORDER and verifies each message
against the variant it lands on — same safety, less freedom. It is a design
constraint imposed by a diagnostics bug, not by the language.

## What was fixed, and what is left

**Fixed — reproducer 1.** The step-7 rule call now runs under
`_derive_eval_guarded`, so the rule's own error is re-raised through `derive`'s
real `exn`:

```
error: derive on "P": the derive rule failed: the rule's OWN diagnosis, naming the exact variant
```

**Still open — reproducer 2's outer swallow.** A top-level `derive` whose
evaluation throws can still be eaten by the anonymous-module begin-expr trial
(`[anon-swallow]`), which is a broader defect than `derive`: a construct whose
whole purpose is to REGISTER an impl has no meaningful "trial" interpretation.
The right fix is to evaluate a top-level `derive` outside that trial, or to
re-raise on the real pass when the trial swallowed. Tracked separately in
`issues/anonymous-module-trial-swallows-a-top-level-derive.md`.

## Note for rule authors

`YO_DEBUG_SWALLOW=1 yo check <file>` is still the tool for the residual case:
the real error appears prefixed `[anon-swallow]` or `[swallow]`. It is no
longer needed for an error the rule raises itself.
