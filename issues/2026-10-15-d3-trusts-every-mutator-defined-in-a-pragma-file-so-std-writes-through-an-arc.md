# D3 trusts every `&mut self` mutator defined in a pragma file, so a std mutator writes through an `Arc` in safe code

**Severity:** S1 — safe code can write an `Arc`'s payload (a data race across threads, and a use-after-free through a borrow §3.13 A2 lets a future hold across a suspension) by calling a prelude or std mutator on it.

**Status:** open. Found 2026-10-15 while narrowing E0909 for the async `Mutex`
(`feat/vbd-async-mutex-rust`), whose `Arc` carve-out relies on D3.

## Symptom

In a file without `pragma(Pragma.AllowUnsafe)`, measured with the stage-1 of
`feat/vbd-async-mutex-rust` (seed v0.2.62 accepts it too):

```yo
W :: struct(o : Option(i64));
main :: (fn() -> unit)({
  a := arc(W(o : Option(i64).Some(i64(1))));
  _t := a.*.o.take(); // accepted: `Option.take(self : &mut Self)` writes the payload
  b := a;
  _u := b.*.o;
});
export(main);
```

`yo check` accepts it. The same place written with `=` (`a.*.o = .None`) or
through a user-defined `&mut` function is D3's error.

## Cause

`d3_check_pending` (`src/evaluator/exprs/assignment.yo`) returns before its
atomic-object loop when the CALLEE is defined in a pragma'd file: "A callee
defined in a pragma'd file is the audited base (`std/sync`'s `self : &mut
Self` methods write only through atomics or locks) and is trusted." The trust
is meant for `std/sync`'s lock and atomic methods, but it covers every
mutator in every pragma'd file, the prelude included (`Option.take`,
`Option.replace`, collection mutators, ...).

## Why it matters now

§3.13 A2's `Arc` carve-out (2026-10-14) accepts a future's shared borrow
through `Arc` derefs because no handle writes an `Arc`'s payload in safe code.
With this hole, another task can `take` a payload field the future reads after
its suspension; with an owning payload (`Option(Box(T))`) the old value is
dropped under the borrow.

## Direction

Trust a pragma'd callee only when its write is interior (through an atomic or
a lock), not because of where it is defined: the callee's mutation mask
already says whether it stores to the parameter's fields. The `std/sync`
methods write through `AtomicX`/`addr_of` of their own handle, which the mask
can tell apart from a field store.
