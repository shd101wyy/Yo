# A `&mut` reference field has no reborrow spelling into a local

**Severity:** S2 — `a := &mut s.r.*` with `r : &mut T` is rejected, and `a := s.r` is (correctly) a partial move, so a local cannot hold the place a `&mut` field refers to; the workaround is passing `s.r` to a `&mut T` parameter or a consuming `match`.

Found while implementing VERDICTS-76 Q1 (the Fable review's edge-case row 12: "row 12 has no working
reborrow spelling today").

```yo ignore
S :: struct(r : &mut i32, n : i32);
main :: (fn() -> unit)({
  mut(x) := i32(1);
  s := S(r : &mut x, n : i32(0));
  a := &mut s.r.*; // rejected
  a.* = i32(2);
});
export(main);
```

```
error: A local borrow cannot reach through a pointer dereference (`p.*`): the storage has no owner the borrow could keep alive. Iterate the collection with `for(&mut coll, x => ...)` to borrow an element, or copy the value out.
  --> r12b.yo:5:17
  |
5 |   a := &mut s.r.*;
  |                 ^
```

## Root cause

`_evaluate_inout_local_binding` (`src/evaluator/exprs/initialization-assignment.yo`) rejects any `*` hop
on the place outside privileged code unless the hop derefs an `Rc`/`Arc` handle. A `*` hop through a
reference FIELD (`s.r.*`) has an owner: the reborrow freezes `s` (the holder, exclusively under
`&mut`) and roots at the places `s.r`'s origin names, as `&mut m.*` does for a reference binding `m`.

## Required behaviour

`a := &mut s.r.*` reborrows: `a`'s places are `s.r`'s origin plus `s` itself, `s` is frozen while `a`
lives, and the E0901 help for `a := s.r` can then name this spelling.
