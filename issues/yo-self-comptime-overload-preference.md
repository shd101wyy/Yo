# yo-self: operator-module `Call` overload picks the RUNTIME candidate

Status: FIXED for comptime-literal operands (f9ad9a121,
yo-self/evaluator/calls/function.yo `_try_expand_call_overload`). The
unrestricted rule is still blocked — see "The preference MUST be gated" below.

## Symptom

```rust
neg_val :: f64(-(50.75));
```

Under the self-hosted compiler (s1):

```
Error: Expected compile-time value for "neg_val".
Got runtime value. Please consider using ":=" instead of "::":
f64(-(50.75))
```

Under the TypeScript compiler: accepted.

Inside a **function body** the error is swallowed (`_trial_eval_fn_body`), so
`check` reports "evaluator OK" and the damage shows up only in codegen: the
statement — and every statement after it, because the body eval ABORTED there —
emits `// Failed to transpile`:

```c
void __yo_user_main() {
  // Failed to transpile neg_val :: f64(-(50.75));
  // Failed to transpile one :: f64(1.0);
  ...
```

That is what made `tests/comptime.test.yo` arms 1-5 and 8-11 hollow (57 markers
in the standalone f64 arm), and with them the whole batch `__yo_user_main`.

## Minimal repro (module level — surfaces the error instead of swallowing it)

```rust
neg_val :: f64(-(50.75));   // FAILS under s1, OK under TS
main :: (fn() -> unit)(());
export(main);
```

Discriminating variants (all under s1):

| expression                   | result |
| ---------------------------- | ------ |
| `f64(-(50.75))`              | FAIL   |
| `x :: -(50.75); f64(x)`      | FAIL   |
| `f32(-(50.75))`              | FAIL   |
| `-(f64(50.75))`              | OK     |
| `-(50.75)`                   | OK     |
| `f64((0.0 - 50.75))`         | OK     |
| `x :: (0.0 - 50.75); f64(x)` | OK     |
| `f64(-(50))` / `i32(-(50))`  | OK     |

So: a FLOAT unary negation feeding a numeric cast. (`tests/comptime.test.yo`'s
f32 arm writes `-(f32(50.75))` — negation OUTSIDE the cast — which is why arm 0
was green while arm 1 (`f64(-(50.75))`) was hollow.)

## Root cause

`-(x)` is a call of the prelude's operator module `(-)`, whose
`Call :: (neg, comptime_neg)` (std/prelude.yo:584-605) holds TWO candidates:

```rust
(neg)          : fn(generic(_Self : Type), self : _Self, where(_Self <: Negate)) -> _Self
(comptime_neg) : fn(generic(_Self : Type), comptime(self) : _Self,
                    where(_Self <: (Comptime, ComptimeNegate))) -> comptime(_Self)
```

Both type-check for a `comptime_float` literal, because a comptime argument bound
to a NON-comptime parameter is lowered to its default runtime type
(`comptime_float` → `f64`; TS does the same at helper.ts:508-525). yo-self's
`_try_expand_call_overload` then had only TS's SECOND tiebreak — "prefer the
single candidate with comptime PARAMETER types" (function.ts:1664-1681) — which
finds nothing here: both parameter types are the SomeT `_Self`, not
`comptime_float`. The first success wins, and the prelude lists the runtime
`neg` first.

A runtime-return call yields `UnknownVal(_Self = f64)` **without executing its
body** (function.yo:4519, faithful to helper.ts:1731), so the cast's argument
carries no comptime value:

```
__DBG_NT arg=-(50.75) target=f64 arg_ty=f64 val=<unknown: f64>
```

`try_to_convert_to_numeric_type` then takes its runtime `__yo_as` lowering
(numeric_type.yo Case 3), whose ExprInfo has `value = .None`, and the `::`
binding rejects it (`initialization_assignment.yo:458`).

The missing piece is TS's **primary** rule, function.ts:1737-1751:

```ts
const comptimeFunctionCalls = functionsWithMatchingTypes.filter(
  (f) => isFunctionType(f.type) && f.type.return.isCompileTimeOnly
);
if (hasRuntimeUnknownArg && comptimeFunctionCalls.length > 0) {
  /* drop the comptime candidates */
} else if (comptimeFunctionCalls.length === 1) {
  functionsWithMatchingTypes = comptimeFunctionCalls; // comptime wins
}
```

> "Comptime function call has higher priority than normal function call. So this
> way we eagerly evaluate the function call that can be done at the compile-time."

## Fix

Port that rule into `_try_expand_call_overload`: among the candidates that
survived the trial calls, if exactly ONE has a comptime-only return
(`Func.meta.result_is_comptime_only`), it wins; otherwise fall through to the
existing comptime-parameter tiebreak.

TS's companion guard — drop the comptime candidates when any ARGUMENT is a
runtime-only `UnknownValue` — cannot be expressed at that point in yo-self,
because each trial evaluates its own fresh-id arg CLONES and there is no shared
evaluated-arg list. That guard turns out to be beside the point anyway: see the
next section for what actually has to gate the rule.

## The preference MUST be gated on foldable operands

First attempt applied TS's rule verbatim (one comptime-returning survivor wins)
and regressed `tests/prelude`, `tests/imm_list`, `tests/imm_string` to rc=1 with
BROKEN C — e.g.

```c
yo_id_4669_...((bool)(// Failed to transpile !((s.is_empty)())), ...)
```

`!(x)` is the same two-candidate shape (`Call :: (not, comptime_not)`), and for a
RUNTIME `bool` operand the comptime candidate still type-checks: yo-self's
`create_unknown_val` leaves `is_runtime_only = false` for a runtime call result,
exactly as TS does (TS sets `isRuntimeOnly` only in index-trait, recur and
property-access field reads), so neither the trial filter (helper.yo:654, a 1:1
port of helper.ts:465) nor TS's own `hasRuntimeUnknownArg` guard rejects it. TS
gets away with picking the comptime candidate because its codegen still emits
the ordinary call; yo-self's comptime route produces no
`runtime_arg_exprs_in_order`, so codegen emits an FTT comment INSIDE the
enclosing expression and the C breaks.

A first narrowing ("every operand not an `UnknownVal`") was still too wide: it
kept `tests/iso` and `tests/rc` broken on

```c
if (// Failed to transpile !((Var.is_owning_the_rc_value)(x))) {
```

`Var.is_owning_the_rc_value` is a macro in **std/prelude.yo:6320** (the shared
std both compilers read — it wraps the `__yo_var_is_owning_the_rc_value`
builtin), and `MACRO_DISPATCH_ENABLED` is `true` in yo-self, so the expansion
does happen.

Isolated to the same root as the `is_empty` case — **a RUNTIME position**.
Bisected from `tests/iso.test.yo` arm 2 (`isolated := ^(x)`, whose `iso` macro
expansion carries the guard) down to, under the wide gate:

```rust
x := Box(i32)(99);
b := !(Var.is_owning_the_rc_value(x));   // rc=1, broken C
b :: !(Var.is_owning_the_rc_value(x));   // folds fine
```

So it is not about macros or about the `cond`-guard position: in a RUNTIME
binding the comptime-preferred call does not fold (yo-self short-circuits CTFE
outside a comptime context, as TS does with `skipCtfeExecution`), and the
non-folding comptime result leaves codegen nothing to emit. One blocker, not
two.

The landed gate is therefore: apply the preference only when every operand is a
comptime **literal** value (`IntLit`/`FloatLit`/`StrLit`) — precisely the operand
class TS's own second tiebreak is written for ("prefer
`fn(comptime_int, comptime_int) -> bool` for `3 > 4`"), generalised to the
generic operator modules whose parameter types are the SomeT `_Self`.
`_trial_call_overload_candidate` gained a `conc_out` out-param that reads the
CLONED args' ExprInfo after the trial, so the real exprs stay untouched.

## The `is_empty` half is now fixed at its real root

yo-self gave every RUNTIME call result an ordinary, NON-runtime-only
`UnknownVal` (`_call_result_unknown`), where TS leaves `expr.$.value`
**undefined** for any call whose return is not `comptime(...)`
(`helper.ts:1752` assigns `returnValue` only inside
`if (functionType.return.isCompileTimeOnly)`). That is why yo-self's otherwise
verbatim port of "Cannot assign runtime argument to compile-time parameter"
(helper.yo ← helper.ts:467-478) accepted `(s.is_empty)()` for
`comptime(self)`: TS FAILS that trial and therefore never even considers the
comptime overload.

Marking runtime call results runtime-only is exactly the remedy TS applied for
the same symptom in `recur.ts:90-107` — its comment names this bug:

> Otherwise overload resolution at the call site of `recur(...)` may incorrectly
> prefer a comptime overload (e.g. `comptime_not` over runtime `not` for
> `!recur(...)`), producing malformed C with a 0-arg comptime function call.

(see `issues/fixed/recur-runtime-result-not-marked-runtime-only.md`.) With the
marking in place, `tests/imm_string`, `tests/imm_list` and `tests/prelude` are
green even with the preference applied to EVERY survivor — measured.

**One holdout keeps the literal gate**, and it is not a runtime operand at all:

```rust
x := Box(i32)(99);
b := !(Var.is_owning_the_rc_value(x));   // RUNTIME binding → broken C
b :: !(Var.is_owning_the_rc_value(x));   // comptime binding → folds
```

The operand's value IS concrete (a `BoolVal` from the
`__yo_var_is_owning_the_rc_value` builtin, reached through the std/prelude macro),
so the trial rightly accepts the comptime candidate — but in a RUNTIME position
its CTFE yields nothing emittable. That reaches codegen through the `iso(...)`
macro's `cond` guard, which is why `tests/iso` and `tests/rc` were the files that
caught it. Next step for removing the gate entirely: find why that CTFE does not
fold in a runtime position (bisected to arm 2 of `tests/iso.test.yo`,
`isolated := ^(x)`).

**To remove the narrowing** (the language rule is that a comptime call always
wins — `1 + 2` must fold to `3`), fix the single blocker: when a
comptime-preferred call's CTFE does NOT fold, attach
`runtime_arg_exprs_in_order` + a result temp so codegen emits the ordinary call
— exactly what the infix-operator block already does at its
`op_result_is_runtime` branch (function.yo). Then widen `ct_successes` back to
every survivor and re-run the two witnesses:
`b := !(Var.is_owning_the_rc_value(x))` and `!((s.is_empty)())`.

## Diagnostic notes

- A `::` statement that emits `// Failed to transpile` means the `::` node has
  NO ExprInfo (codegen `generation.yo:394-402`) — i.e. the enclosing body eval
  THREW there. `::` itself is a no-op emitter (`generation.yo:490`), so it can
  only fail that way.
- Move the failing statement to MODULE level to see the swallowed error: module
  begin exprs are not wrapped in the def-time swallow.
- `comptime_assert` is a poor oracle here: it passes vacuously when its argument
  is not a concrete bool.
- **Count FTT markers with an UNANCHORED grep.** A failing sub-expression emits
  its comment MID-LINE (`(bool)(// Failed to transpile ...)`), which
  `grep -cE '^\s*// Failed to transpile'` reports as zero. The line-anchored
  form is only correct for the stage2 self-compile count, where it exists to
  skip the compiler's own `"// Failed to transpile"` string literals. For test
  and repro files, prefer a full compile (no `--skip-c-compiler`) so clang is
  the judge.
