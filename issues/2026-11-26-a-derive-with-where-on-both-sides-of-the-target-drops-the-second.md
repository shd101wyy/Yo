# A derive with `where` on both sides of the target drops the second clause

**Severity:** S3 — `derive(generic(T : Type), where(T <: Eq(T)), Pair(T), where(T <: Clone), Clone)` forgets `T <: Clone`, so `Pair(NoClone).clone()` fails with E0610 inside auto-generated code instead of E0602 at the call.

Filed 2026-11-26 by the `bound-s1` lane while wiring the `where` form check into `derive`.
Reproduced with a stage 1 of `fix/bound-forms-and-send-gate`.

## Reproducer

```yo
{ println } :: import("std/fmt");
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
NoClone :: struct(x : i32);
derive(NoClone, Eq(NoClone));
derive(generic(T : Type), where(T <: Eq(T)), Pair(T), where(T <: Clone), Clone);
main :: (fn() -> unit)({
  p := Pair(NoClone)(a : NoClone(x : i32(1)), b : NoClone(x : i32(2)));
  q := p.clone();
  println(`${q.a.x}`);
});
export(main);
```

```text
error[E0610]: No method "clone" on NoClone: the type has no field or method with that name.
Receiver slot types probed: NoClone, &NoClone, &mut NoClone, &&NoClone.
  --> auto-generated://
```

## Root cause

`evaluate_derive` (`src/evaluator/builtins/derive.yo`) keeps one `where_arg_opt`: the clause after the target is taken only
`if(where_arg_opt.is_none(), …)`, so with a clause before the target the second one is skipped (its form is checked, its
bounds are not forwarded to the generated impl).

## Fix

Forward both clauses (the generated impl takes a `where` at both positions), or reject a second `where` at the derive.
