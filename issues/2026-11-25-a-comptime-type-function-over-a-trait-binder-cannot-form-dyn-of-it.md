# A comptime type function over a `Trait` binder cannot form `Dyn(Tr)`: its definition is rejected

**Severity:** S3 — a generic type alias such as `Boxed :: (fn(comptime(Tr) : Trait) -> comptime(Type))(Box(Dyn(Tr)))` is rejected where it is defined, so a `Dyn` over a trait parameter cannot be spelled once and reused; every use spells `Box(Dyn(Trait))` in full. Nothing wrong reaches a binary.

Filed 2026-11-25 by the dyn-future-reject lane. VERDICTS-80 asked for a test that a `Future` substituted into such a binder is E0614 too; the alias does not get that far. Reproduced with the v0.2.79 seed and with a stage 1 of `fix/dyn-future-reject` (develop `13af89b04` plus the VERDICTS-80 checker).

## Reproducer

```yo
Boxed :: (fn(comptime(Tr) : Trait) -> comptime(Type))(Box(Dyn(Tr)));
main :: (fn() -> unit)({
  _x := Option(Boxed(ToString)).None;
});
export(main);
```

`yo check`:

```text
error: Expected a trait type for argument 1 of 'Dyn' expression.
  --> a1.yo:1:63
  |
1 | Boxed :: (fn(comptime(Tr) : Trait) -> comptime(Type))(Box(Dyn(Tr)));
  |                                                               ^^
```

With `comptime(Tr) : Type` the message ends `got:\nTr`, the same rejection.

## Root cause (first pass)

The comptime function's body is evaluated at its definition with `Tr` still a binder, and `evaluate_dyn_type` (`src/evaluator/types/dyn.yo`) requires every argument to evaluate to a `TypeVal` holding a trait type: an unbound comptime parameter is neither, so the definition throws. A binder whose kind is `Trait` (or `Type`) should defer the `Dyn` to the application, where `Tr` is known, as other type constructors over a comptime type parameter do.

Once the definition is accepted, the application evaluates `Dyn(Tr)` through `evaluate_dyn_type` with `Tr` bound, so the VERDICTS-80 check (`Dyn(Future(...))` is E0614) covers the alias with no second check site. The fix's test should apply the alias to `Future(i32, Io)` and expect E0614.
