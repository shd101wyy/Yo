# Verifier: a variant constructed inside a `cond` arm is "an uncontracted, untyped callee"

**Severity:** S3 — `yo verify` reports a subset error (never a wrong verdict) for a common, fully verifiable shape; the workaround is a statement-level binding per variant.

- **Component:** `src/verifier/vc.yo` — `_call_term` / `_callee_call_term`; the
  evaluator's ExprInfo for `cond` arm values.
- **Found:** 2026-09-30, while writing
  `tests/spec/fixtures/valid/nullary_variant_construction.yo`.

## Reproducer (tree build of `feat/verifier-list-get-pop`)

```rust
pragma(Pragma.Verify);
Color :: enum(Red, Green(v : i32));

pick :: (fn(b : bool, ensures(r == cond(b => i32(1), true => i32(0)))) -> (r : i32))({
  (c : Color) = cond(
    b => Color.Green(i32(7)),
    true => Color.Red
  );
  match(c, .Red => i32(0), .Green(_) => i32(1))
});
```

```
subset   fn@...:15 [verify] — cannot verify: call to an uncontracted, untyped callee
         (Color.Green)(i32(7))
```

The shorthand `.Green(i32(7))` fails the same way. The same construction as a
plain statement (`(c : Color) = .Red;`) verifies.

## What is known

Measured: the arm's construction reaches `_callee_call_term` instead of the
enum-construction branch of `_call_term`. Reasoned, not yet traced: that
branch is gated on `_is_value_enum_type(info.ty)`, so the arm value's ExprInfo
most likely carries no enum type, which would mean the evaluator records no
type for `cond` arm values.

## Recommendation

Trace the ExprInfo of a `cond` arm value first. If it is empty, the fix
belongs in the evaluator's `cond` walk (record each arm value's type), not in
a verifier-side fallback.
