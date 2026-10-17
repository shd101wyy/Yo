# A generic `Copy` impl rejects a field that is a conditional-`Copy` container of its parameter

**Severity:** S2. A valid conditional `Copy` impl is rejected, so the type cannot be `Copy` at all, whether derived or written by hand.

**Status: OPEN.** Found 2026-10-17 while fixing `issues/fixed/a-generic-derive-cannot-clone-a-field-whose-type-is-a-generic-container-of-its-parameter.md`. **Measured on:** that branch's tree build (develop 4d7c15caa plus the fix).

## Symptom

```yo
CP :: (fn(comptime(A) : Type) -> comptime(Type))(struct(n : i32, p : Option(A)));
derive(generic(A : Type), where(A <: Clone), CP(A), Clone);
impl(generic(A : Type), where(A <: Copy), CP(A), Copy());
main :: (fn() -> unit)({
  a := CP(i32)(n : i32(1), p : .Some(i32(2)));
  b := a;
  _x := (a.n + b.n);
});
export(main);
```

```
error[E0602]: Type "CP(A : (Copy))" cannot implement "Copy": its field `p` has type `Option(A : (Copy))`, which does not implement required trait "Copy". …
```

The `where` after the receiver fails the same way, and so does `derive(generic(A : Type), where(A <: Copy), CP(A), Copy)`. A field typed by the bare parameter passes. `IterFilterMap(I, B, F)`'s fields are `I` and `F`, and its pair works.

## Cause

`_first_non_copy_part` (`src/evaluator/trait_checking.yo`) asks `type_implements_trait(Option(A), Copy)` while the impl is registered, with `A` still an abstract type variable that carries `Copy` as a required trait. `Option`'s `Copy` is a conditional generic impl (`where(T <: Copy)`). Generic-impl matching (`try_match_generic_impl`, `src/evaluator/values/impl.yo`) does not treat an abstract binding as a match, so the question answers no, even though `A`'s own bound discharges the impl's `where`. The deferred trial of a generic method body hits the same limitation. There it is harmless, because each specialization re-checks the body.

## Fix direction

Decide this at the impl: a field whose type is an instantiation `G(..., A, ...)` with abstract type variables is `Copy` when `G`'s conditional `Copy` impl's `where` clauses are discharged by those variables' required traits. Alternatively, defer the field check to each concrete instantiation, as the method bodies already are. Then give `IterPeekable` its `Copy` derive (`plans/backlog/SEED_VERSION_AUTOMATION.md`, "a generic derive over a container of its parameter").
