# An aliased `Rc` handle lent `&mut` to a call is freed under its alias

**Severity:** S1 — `b := a; f(&mut b)` where `f` stores a new handle into `b` frees the object `a` still names: a heap use-after-free and a double drop in safe code.

**Found:** 2026-10-15, by decision 46 Generation A (`feat/vbd-d46-gena`) while checking that `Rc.make_mut` sees the true count of a handle that was copied.

## Reproducer

v0.2.63 (and develop at 0684c9c40):

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
P :: struct(n : i32, s : String);
reset :: (fn(h : &mut Rc(P)) -> unit)({
  h = rc(P(n : i32(2), s : String.from("new")));
});
main :: (fn() -> unit)({
  a := rc(P(n : i32(1), s : String.from("old")));
  b := a;
  reset(&mut b);
  println(&b.s);
  println(&a.s);
});
export(main);
```

```text
$ yo compile repro.yo --sanitize address --allocator system -o r && ./r
==426801==ERROR: AddressSanitizer: heap-use-after-free on address 0x76d59f6e18b0
READ of size 8 ...
```

The same happens through a method whose receiver is the handle itself, `b.replace(...)` with `self : &mut Self` on a `ref(struct(...))` type, and with the roles swapped (`reset(&mut a)` while `b` is read later).

## Root cause

The alias elision in `_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) lets `b := a` share ONE count: the dup at the binding is cancelled and the alias is marked consumed, so only the base releases the count at its scope end. That is sound only while nothing releases the shared count before the alias's last use, and `_subtree_assigns_variable` guards it by looking for an assignment `a = …` or `b = …` in the block. A `&mut b` lend is a write to the slot the guard never saw: the callee's `h = rc(...)` drops the old value, which releases the one shared count, frees the object, and leaves `a` dangling. At scope end `a`'s drop releases it again.

The same blind spot made `ref_count` lie after an alias: `b := a; ref_count(a)` is 1. A uniqueness door (`Rc.make_mut`, `Rc.try_unwrap`) that trusts the count would write through `b` into the cell `a` still names.

## Fix

`_subtree_assigns_variable` treats a `&mut name` lend, and a method call whose `self : &mut Self` receiver is `name` itself (read from the resolved method type, since a receiver carries no marker), as an assignment of `name`. The alias then keeps its own count, so the callee's replacement releases only the alias's reference.

## Verification

`tests/rc.test.yo`: "an alias lent &mut to a call that replaces it leaves the base its object", the base-lent variant, and "an alias whose &mut self method replaces it leaves the base its object". Each sums the tags its `Drop` sees: 1 + 10 when each object is dropped once. Before the fix the original was dropped twice (once freed under the alias) and the replacement never. `tests/rc.test.yo`'s `Rc.make_mut` cases rely on the same count.
