# An index place lent to a borrowing future skips the shared-cell check

**Severity:** S1 — a future kept a pointer into a collection's buffer while
another task reallocated it: lost writes and bus errors.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
bump :: (fn(c : &mut i32, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ &mut c }(io : Io) => { io.await(yield(io), io); c = (c + i32(1)); })
);
xs := ArrayList(i32).new();
xs.push(i32(1));
other := xs;                      // a second handle, given to a spawned task that pushes 256 items
io.await(bump(&mut xs(usize(0)), io), io);   // accepted
```

Three runs gave `rc=138` (bus error), `1`, `rc=138`; the right answer is 2.
`io.await(bump(&mut r.*(usize(0)), io), io)` through an `Rc(ArrayList)` was
accepted too, while `&mut r.*.c` was E0909.

## Root cause

`capture_place_crosses_cell` (`src/evaluator/utils.yo`) walked only `.` hops.
An index call stopped the walk at once, so it never saw the `ref`
`ArrayList` receiver or the `r.*` deref. The decision-28 interior mark that
`&mut xs(i)` takes is call-scoped and was released when `bump` returned the
future that still held the element's address. The capture-list path rejects
index places on its own, so only the lend-to-a-call route was open.

## Fix

`capture_place_crosses_cell` treats an index hop as a cell when the element
is reached through the `Index` trait (the `*(T)` the index method returns:
the element lives in a buffer the container owns behind a pointer), or when
the indexed value is a pointer or a `ref` object. An element of a fixed-size
array is part of the array's own storage, so the walk continues to the array.

Regression test: `tests/async_await.test.yo`, "a borrowing future cannot hold
an element lent through an index".
