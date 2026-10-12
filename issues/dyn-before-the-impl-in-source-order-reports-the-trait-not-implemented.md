# `dyn(v)` written above the `impl` it needs reports the trait as not implemented

**Severity:** S2 — a valid program is rejected: a `dyn(v)` in a function body
that precedes the type's `impl` in the module fails to type-check.

Found 2026-10-13 while probing the `dyn(v)` borrowing-future rule
(`issues/fixed/a-dyn-method-future-carries-no-borrows.md`). Reproduces with
the v0.2.59 seed and with the tree compiler.

## Symptom

```yo ignore
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (d : Dyn(Speak)) = dyn(C(n : i32(41)));
  println(&d.speak());
});
export(main);
Speak :: trait(speak : (fn(self : &Self) -> i32));
C :: struct(n : i32);
impl(C, Speak(speak : (fn(self : &Self) -> i32)(self.n)));
```

```
error: Type C does not implement the trait Speak required by dyn(Speak).
  --> tmp/fix2/dyn5.yo:3:22
  |
3 |   (d : Dyn(Speak)) = dyn(C(n : i32(41)));
  |                      ^^^
```

Moving `main` below the `impl` makes the program check and run.

## Expected

`::` definitions and `impl` registration are order-independent within a module
(`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), so the program should check in
either order.

## Where to look

`_require_dyn_traits_implemented` (`src/evaluator/values/dyn.yo`) asks the
trait registry while `main`'s body is evaluated, before the module walk has
registered the later `impl`. A method call on a concrete receiver resolves
the pending `impl` on demand; the `dyn(v)` trait check (and
`_resolve_dyn_trait_values`, which builds the vtable from the same registry)
does not.
