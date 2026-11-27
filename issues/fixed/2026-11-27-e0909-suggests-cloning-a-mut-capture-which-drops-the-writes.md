# E0909 suggests cloning a `&mut` capture, which silently drops the closure's writes

**Severity:** S3 — following the help line changes the program's meaning: for a closure holding `{ &mut seen }` at a by-value slot, E0909 said "capture a value instead (`{ seen : seen.clone() }`)", and the clone's writes never reach `seen`.

Filed 2026-11-27 by the `v81-s1` lane from VERDICTS-93 §6 finding 5 (probes `a1`, `s1`); fixed in the same branch.

## Reproducer

`issues/repros/2026-11-27-e0909-suggests-cloning-a-mut-capture-which-drops-the-writes.yo`:

```yo
{ println } :: import("std/fmt");
run :: (fn(a : i32, f : Impl(FnOnce(a : i32) -> unit)) -> unit)({
  f(a);
});
main :: (fn() -> unit)({
  mut(seen) := i32(0);
  run(i32(7), { &mut seen }(a) => {
    seen.* = a;
  });
  println(`${seen}`);
});
export(main);
```

```text
error[E0909]: This value borrows `seen` (the capture `seen : &mut seen` at a1_byvalue_fnonce_mut_capture.yo:8:22), so it is second-class and cannot be moved into a by-value (`sink`) parameter: a borrow never outlives the scope that lends it.
help: capture a value instead (`{ seen : seen.clone() }`), or keep the closure local to the scope that owns `seen` and call it there
```

## Root cause

`reject_second_class_escape` (`src/evaluator/utils.yo`) built one help line for every capture borrow, `&` and `&mut` alike.
For a `&` capture a clone is a faithful repair (the closure only reads); for a `&mut` capture it is not.

## Fix

For a `&mut` capture (`CaptureBorrow.is_mut`) the help now says: keep the closure local to the scope that owns `seen` and
call it there, or pass it to a parameter that lends it (`f : &mut Impl(FnMut(...))`); a copy (`.clone()`) would take the
writes away from `seen`. A `&` capture keeps the clone repair. Pinned in `tests/option-result-combinators.test.yo`
("E0909 on a &mut capture names a lending parameter, not a clone"). The block-escape helps at `src/evaluator/utils.yo`'s
other two `.clone()` suggestions (a holder declared before its root, a block-local root) are a different diagnostic and
were left as they are.
