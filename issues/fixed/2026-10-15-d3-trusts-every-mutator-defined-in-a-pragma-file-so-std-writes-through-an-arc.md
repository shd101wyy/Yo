# D3 trusts every `&mut self` mutator defined in a pragma file, so a std mutator writes through an `Arc` in safe code

**Severity:** S1 — safe code can write an `Arc`'s payload (a data race across threads, and a use-after-free through a borrow §3.13 A2 lets a future hold across a suspension) by calling a prelude or std mutator on it.

**Status:** FIXED 2026-10-15 (branch `fix/d3-trust-by-mutation-mask`). Found
2026-10-15 while narrowing E0909 for the async `Mutex`
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

## Fix

`d3_check_pending` no longer returns early for a callee defined in a pragma'd
file: the callee's mutation mask decides for every callee, wherever it is
defined. A `&mut` argument (or `self : &mut Self` receiver) whose place is
under an atomic object (an `Arc` payload, a user `atomic(ref(...))`) is
rejected when the mask says the callee may write that parameter
(`Option.take`, `Option.replace`, ...), and a read-only `&mut self` callee
still passes, as it did for user callees.

What stays exempt, and why:

- **std's own internal writes.** `d3_record_inout_place` skips a place in a
  pragma'd CALLER, so `Mutex.with_lock`'s `body(&mut self._value)` and the
  `std/sync` internals are judged where they happen, as before.
- **`std/sync`'s handles.** Their methods take `self : Self` or
  `self : &Self` and write through C11 atomics or a lock. `param_is_ref`
  marks only `&mut` parameters, so no binding of theirs reaches D3; the
  file-level trust was not load-bearing for them.

The same early return also skipped the D1 branch (a `&mut` argument rooted
in a module-level global). `g.take()` on a value global that a spawned
closure reads is now the same mutable-static error that `g = .None` already
was: a deliberate tightening, the same race through a different spelling.
Since decision 47 step 1 (#1401) that shape is rejected earlier still: a
`&mut` lend of an unmarked global is E0917 and of a `mut(g)` global is E0916,
both before D1, so the regression test pins the E0916 on a `mut(g)` global.

## Regression tests

`tests/parallelism_soundness.test.yo`, next to the other D3 cases:

- `a.*.o.take()` and `a.*.o.replace(..)` on an `Arc(Slot)`;
- the thread version: a second handle's `Thread.spawn` body takes the field
  while the spawning thread reads it;
- the task version: an `io.async` task takes the field while
  `io.await(_slot_peek(&a.*, io), io)` holds the borrow (on develop the
  borrow alone is still E0909 until the §3.13 A2 `Arc` carve-out lands; the
  test pins the D3 message, which fires first);
- D1: `g_d3_slot.take()` on a `mut(g_d3_slot)` global while a spawned thread
  reads it (E0916 since #1401);
- canaries: `take`/`replace` on an owned value, `take` through a `&mut`
  parameter and inside `Mutex.with_lock`, and `is_some`/`unwrap_or` through
  an `Arc` still compile and run.
