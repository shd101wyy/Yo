# yo-self: derived-Eq `==`/`!=` on enums (and structs) returns unit under def-eval

## Status: OPEN — the dominant `check ./yo-self` propagation blocker

Under the def-eval propagation experiment, `check ./yo-self` is ~31/228.
The single most common failure (≈190 files) is:

```
Error: Expected bool type for "or" argument, got TYPE=unit for:
k == (ZK.A)
```

i.e. a derived-`Eq` `==`/`!=` comparison used as an operand of `||`/`&&`
(or assigned to a `bool`) resolves to **unit** instead of **bool**.

## Faithful minimal repro

```rust
ZK :: enum(A, B, C);
derive(ZK, Eq(ZK));
ztest :: (fn(k : ZK) -> bool)(
  (k == ZK.A) || (k == ZK.B)   // → "Expected bool type for or argument, got unit"
);
```

TS (`./yo-cli check`) accepts this — evaluator OK. yo-self
(`/tmp/yo-self-dbg` under the experiment) reports unit. A bare
`enum` WITHOUT `derive(..., Eq(...))` is correctly rejected by BOTH
(TS: "No matching call found") — so the bug is specifically in the
DERIVED `==` path, not in a missing structural fallback.

Also fails (same root, isolates it from `||`):

```rust
(x : bool) = (k == ZK.A);   // Incompatible types: Expected bool, Given unit
```

## What is NOT the cause (ruled out)

- Not `expected_type` leakage: clearing `ctx.expected_type` before the
  arg eval in `and_or.yo` did not change the unit result.
- Not the `and_or` evaluator's non-raw `evaluate_expression` (though that
  IS a separate faithfulness bug — see below): switching it to
  `evaluate_expression_raw` surfaced the same unit type with no thrown
  error, so the `==` genuinely evaluates to unit.
- Not a missing operator-dispatch route: `==` IS dispatched through the
  operator path in `calls/function.yo` (the `is_infix_call &&
op_is_operator` block ~line 626). For a derived-Eq enum, that path's
  `get_receiver_methods_by_name_from_env(env, "==", ZK, true)` returns
  the derived method but the call yields unit.

## Where to look (root is in the derived-Eq machinery)

`__derive_eq` (std/prelude.yo:6712, registered via
`derive_rule(Eq, __derive_eq)`) builds the enum `==` impl by:

1. folding a `match(lhs, .A => match(rhs, .A => true, _ => false), …)`
   body as a **comptime_string** (`__yo_comptime_fold_range` + `__sN`
   concat helpers),
2. `match_body.to_expr()` to parse the string back to an AST,
3. `ctx.make_impl(quote(Eq(...)( (==) : ((lhs, rhs) -> #(match_body…)) )))`.

The derived `==` body is therefore produced by comptime-string →
`to_expr` → macro `make_impl`. The unit result most likely comes from
one of: `to_expr` / `comptime_string_to_expr`, the `make_impl` macro
expansion, or the derived method's body (`match(...)` returning
true/false) evaluating to unit under def-eval when `lhs`/`rhs` are
unknown. Bisect by:

- checking whether the derived `==` METHOD is registered against `ZK`
  at all (dump the trait-method registry for the enum id), and what its
  return TYPE is recorded as;
- if registered with a bool return, the call path drops it → look at the
  operator-dispatch return-type resolution in `calls/function.yo`;
- if registered with a unit return (or not at all), the derive
  machinery (`to_expr`/`make_impl`/comptime-string fold) is the culprit.

## Companion faithfulness fix (do alongside, not alone)

`evaluator/builtins/and_or.yo` uses the SWALLOWING `evaluate_expression`
for its operands; TS `and-or.ts` uses the propagating `evaluateExpression`
(`context: {...context}`). Switch to `evaluate_expression_raw(arg,
cur_env, ctx, exn)`. This is faithful and is what makes the enum-`==`
error visible rather than silently unit — but committing it ALONE
(without the enum-`==` fix) changes `&&`/`||` error propagation broadly,
so land them together.

## Impact

Fixing this should unblock the bulk of `check ./yo-self` under
propagation in one shot (≈190 files share this single root).
