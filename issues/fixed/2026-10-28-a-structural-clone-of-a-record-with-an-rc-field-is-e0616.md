# A structural `clone()` of an anonymous record or closure holding an `Rc` is E0616 in auto-generated code

**Severity:** S2: a valid program is rejected. `.clone()` on an anonymous
record (or a closure) with an `Rc(T)` field reports E0616 against code the
compiler generated itself, and the user has no spelling that avoids it.

> Found 2026-10-28 by the V2c tests sweep: `tests/rc.test.yo`, "Test Rc in
> different data structures". The sweep spells `z := { y : y.clone() }` for a
> record `y := { x : Rc.clone(x) }` that is read again. Pre-existing on develop
> `c847d0b76`.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  x := Rc(i32)(3);
  y := { x : Rc.clone(x) };
  z := y.clone();
  println(`${z.x.*} ${y.x.*} ${ref_count(x)}`);
});
export(main);
```

```
error[E0616]: "clone" is a method of Rc(i32) and of its payload i32, so (y.x).clone(...) could mean either (plans/VALUES_BY_DEFAULT.md decision 32).
  --> auto-generated://
_(x : __yo_clone_recv.x.clone())
```

## Root cause

`structural_clone_expansion` (`src/evaluator/utils/closure.yo`, decision 36)
builds a clone template field by field and spells every non-`Copy` field
`<recv>.<label>.clone()`, and a capture `__yo_capture_field(c, i).clone()`.
On an `Rc` field that is the method-call form decision 32 rejects as
ambiguous, because `Rc(i32)` and its payload `i32` both have `clone`.

## Fix

`_clone_template_of` spells a prelude handle's clone through its constructor
(`Rc.clone(<read>)`, `Arc.clone(<read>)`, chosen by `_rc_clone_spelling`). Any
other field keeps `.clone()`.

Test: `tests/copy_trait.test.yo`, "Clone: a structural clone of a record or a
closure holding an Rc clones the handle".
