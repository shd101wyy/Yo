# A capture-list entry cannot move a `&mut` reference into the closure

**Severity:** S3 — `{ m }` with `m : &mut T` is rejected although a `&mut` reference moves at every other by-value position (VERDICTS-76 Q1); the workaround `{ m : &mut m.* }` reborrows for the closure's life.

Found while implementing VERDICTS-76 Q1 (the Fable review's edge-case row 20: "May be its own PR; until
then keep the rejection").

```yo ignore
main :: (fn() -> unit)({
  mut(x) := i32(1);
  m := &mut x;
  (f : Impl(FnOnce() -> unit)) = ({ m }() => {
    m.* = i32(2);
  });
  f();
});
export(main);
```

```
error: `m` is a `&mut` reference, and the by-value entry `m` would move it into the closure, which cannot take it. Reborrow it for the closure's life with `{ m : &mut m.* }`.
  --> r20.yo:4:37
```

## Root cause

The capture-list evaluator (`src/evaluator/values/anonymous-function.yo`, the `ref_copy_var` arm) copies
a reference binding's entry as the reference (R-CAP-1), which is right for a `Copy` `&T`; for a `&mut T`
it rejects instead of consuming `m` and giving the closure `m`'s origin.

## Required behaviour

The by-value entry `{ m }` moves `m` into the closure: the closure's capture borrows are `m`'s places, a
later use of `m` is E0901, and the reborrow entry `{ m : &mut m.* }` stays the way to keep `m`.
