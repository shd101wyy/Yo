# A variant called through an unapplied enum constructor calls its payload "the receiver"

**Severity:** S3 — a misleading diagnostic. `Option.Some(x)` is E0613 "they are inferred from the first argument,
the receiver, which has type `X`, not an instance of `Option`": a variant constructor has no receiver, and `x` is
its payload. `Option(X).Some(x)` and `(o : Option(X)) = .Some(x)` are accepted.

- Filed: 2026-11-28 by the `v81-infer-first` lane (VERDICTS-90 probe `a8_some`).
- Reproduces with the v0.2.80 seed.

## Reproducer

```yo
X :: struct(n : i32);
main :: (fn() -> unit)({
  x := X(n : i32(1));
  o := Option.Some(x);
  ()
});
export(main);
```

```text
error[E0613]: Cannot infer the type parameters of `Option` in `Option.Some(...)`: they are inferred from the first argument, the receiver, which has type `X`, not an instance of `Option`.
  --> tmp/a8b.yo:4:8
```

## Root cause

Static-argument inference (`_infer_unapplied_ctor_receiver`, `src/evaluator/calls/function.yo`, decision 32)
covers methods of an unapplied constructor: it finds no static candidate for `Some` (a variant, not an `impl`
member), falls back to the receiver-method reading, and words the payload as the receiver. Whether a variant
through an unapplied constructor should infer its type arguments (`Option.Some(x)` as `Option(X)`) is not decided.
If it should not, the message should say so and name `Option(X).Some(x)` or an expected type.
