# A generic type's function taken as a value is not emitted

**Severity:** S2 — a program that passes `check` fails in the C compiler (`use of undeclared identifier`) or, when the function does not use the type parameter, compiles to a binary that aborts with `yo: FATAL: reached ..., whose body failed to transpile`; calling the function directly works.

**Status:** OPEN. **Found:** 2026-10-13, probing the shapes of
`issues/fixed/dyn-of-a-named-function-value-emits-invalid-c.md` (independent of
`dyn`: a plain `fn(...)` binding fails the same way).

## Repro

```yo
{ println } :: import("std/fmt");
_Cell :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), _Cell(T), make : (fn(v : T) -> Self)(Self(v : v)));
impl(generic(T : Type), _Cell(T), twice : (fn(x : i32) -> i32)(x * i32(2)));
main :: (fn() -> unit)({
  (k : (fn(v : i32) -> _Cell(i32))) = _Cell(i32).make;
  (t : (fn(x : i32) -> i32)) = _Cell(i64).twice;
  println(`${k(i32(1)).v} ${t(i32(4))}`);
});
export(main);
```

- `make` (its signature uses `T`): `yo check` passes, and the C compiler
  reports `use of undeclared identifier 'yo_id_…'` for the function value.
- `twice` alone (no `T` in it): the program compiles and aborts at the call
  with `yo: FATAL: reached yo_id_…, whose body failed to transpile`.
- `ArrayList(i32).new` taken as a value fails the same way (undeclared
  identifier, and `__yo_v_current_allocator` undeclared), so does passing it to
  an `Impl(Fn() -> ArrayList(i32))` parameter, and so does `dyn(...)` of any of
  them.

## Analysis (not root-caused)

A method of a generic impl is specialized when it is CALLED. Read as a value
(`_Cell(i32).make`), the member access yields the impl's generic `FuncVal`,
with the instantiation's types in its signature but no specialization, so
codegen references a function it never emits (`make`) or emits only the abort
stub of the swallowed generic trial (`twice`).

## Direction

Specialize the method at the member access when it is taken as a value, the
way a call specializes it, so the value names an emitted function.
