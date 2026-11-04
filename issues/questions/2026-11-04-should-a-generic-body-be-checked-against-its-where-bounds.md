# Should a generic body be checked against its `where` bounds (Ada's contract model) rather than only at instantiation?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-04 from the Ada/SPARK lessons audit (`plans/backlog/ADA_SPARK_LESSONS.md`, language item 4).

## The question

Yo type-checks a generic body against each instantiation (the template model). A body may therefore use operations that its `where` bounds do not provide, as long as every type it is actually called with has them:

```yo
{ println } :: import("std/fmt");
// The bound names only Eq; the body uses +.
f :: (fn(generic(T : Type), x : T, y : T, where(T <: Eq(T))) -> T)(x + y);
main :: (fn() -> unit)({
  z := f(i32(1), i32(2));
  println(`${z}`);
});
export(main);
```

This compiles and prints `3` (tree binary of develop `8559f3a26`). Ada's contract model checks a generic body "given the properties of the formals" (RM 12.3(11/5)), so the body above would be illegal and `T` would need a bound providing `+`. Rust's trait bounds and Swift's protocols make the same choice.

## What each answer costs

- **Template model (today).**
  - Gains: no bound bookkeeping, and comptime-heavy generic code works.
  - Costs: a generic's signature does not tell a caller what it needs; an error appears at the call site, inside the body, as with C++ templates; a never-called body is only partially checked (`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`); and the verifier cannot reason about a generic body abstractly from its bounds.
- **Contract model.**
  - Gains: the signature is the whole interface, errors point at the definition, and the verifier can verify a generic body once against its bounds (`plans/backlog/FORMAL_VERIFICATION.md` generic callees).
  - Costs: every operation needs a trait, including arithmetic. Yo has `Add`/`Integer`-style traits, but bounds would get longer. Comptime-dependent bodies (`T.BYTES`, reflection) need an escape hatch, and std plus `src/` would need a migration sweep (a Generation A warning, then a Generation B error).

## Recommendation

Adopt the contract model in two steps, after the VALUES_BY_DEFAULT campaign:

1. **Generation A.** A warning when a generic body uses an operation on a type variable that no bound provides (method, operator or field). Exempt bodies whose use goes through `comptime` reflection on the type. Measure the warning count over `std/` and `src/` first.
2. **Generation B.** Once std and src are clean, make it an error. Keep a documented, explicit opt-out for comptime-reflective generics instead of the silent template fallback.

This makes signatures honest, lets the verifier treat a generic as its bounds, and matches Yo's existing preference for explicit interfaces (no overloading, explicit `where`).
