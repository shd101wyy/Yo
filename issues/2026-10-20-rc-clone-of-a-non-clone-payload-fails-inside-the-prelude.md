# `Rc(T).clone()` on a payload with no `Clone` fails inside the prelude, not at the call

**Severity:** S3 — the program is rightly rejected, but by the wrong rule: the prelude impl whose `where(T <: Clone)` fails is selected anyway, so the diagnostic is the impl body's error (with a note into `std/prelude.yo`), and a user impl for the same receiver loses to it.

**Status:** OPEN — found 2026-10-20 while building `SharedList` for
`perf/share-typevalue-lists` (the generic `impl(generic(T), Rc(Cell(T)), Clone(...))`
the branch first tried lost to the prelude's impl the same way). Not fixed
there; the branch declares `Clone` per concrete instantiation instead.

## Reproducer

`issues/repros/2026-10-20-rc-clone-of-a-non-clone-payload.yo` (seeds v0.2.66 and v0.2.67):

```
error[E0610]: No method "clone" on Cell: the type has no field or method with that name.
     --> tmp/rr.yo:12:9
  12 |   b := a.clone();

note: raised here, inside the standard library
     --> std/prelude.yo:9803:47
9803 |     clone : (fn(self : &Self) -> Self)(rc(self.*.clone()))
```

`Cell` derives nothing, so `Cell <: Clone` is false and the prelude's
`impl(generic(T : Type), where(T <: Clone), Rc(T), Clone(...))` should not
match `Rc(Cell)`. The method lookup selects it anyway and only the body's
`self.*.clone()` fails. The expected diagnostic names the receiver the user wrote: no `clone` on
`Rc(Cell)` because `Cell` is not `Clone`, with no note into the prelude.

## Second symptom

A user `impl(generic(T : Type), Rc(Cell(T)), Clone(clone : (fn(self : &Self) -> Self)(self)))`
for a non-`Clone` `Cell(T)` loses to the same prelude impl: `rc(Cell(i32)(...)).clone()`
reports the same prelude error instead of calling the user impl. A concrete
impl (`impl(Rc(Cell(String)), Clone(...))`) is selected correctly.

## Likely cause

The where-clause of a generic impl is not consulted when the receiver
method is resolved (or the generic prelude impl wins the tie with a user
generic impl before the where-clause is checked). Not investigated further.
