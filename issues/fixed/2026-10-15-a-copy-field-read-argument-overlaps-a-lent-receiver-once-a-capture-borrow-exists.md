# A Copy field read argument overlaps a lent receiver once a capture borrow exists

**Severity:** S2 — `self.m(self.tail)` (a `u64` field passed by value to a `self : &mut Self` method) was rejected with E0910 in any module checked after some capture list had recorded a borrow, so a valid program failed depending on what had been evaluated before it

**Found:** 2026-10-15, on the A5 branch `feat/vbd-v3-async-a5` at 91e8e87d1: `yo check src/version_cache.yo --std-path ./std` rejected `std/hash.yo`'s `DefaultHasher._push_byte` (`self._compress(self.tail);`). A5 worked around it with `t := self.tail; self._compress(t);` (58adc48b5).
**Status:** FIXED 2026-10-15.

## Symptom

```yo
{ assert } :: import("std/assert");
_borrow_first :: (fn() -> i32)({
  n := i32(0);
  (f : Impl(Fn() -> i32)) = ({ &n }() => n);
  f()
});
_H :: struct(state : u64, tail : u64);
impl(
  _H,
  _mix : (fn(self : &mut Self, v : u64) -> unit)({
    self.state = (self.state + v);
  }),
  push : (fn(self : &mut Self, b : u64) -> unit)({
    self.tail = b;
    self._mix(self.tail);
  })
);
main :: (fn() -> unit)({
  assert(_borrow_first() == i32(0), "borrow");
  h := _H(state : u64(1), tail : u64(0));
  h.push(u64(5));
  assert(h.state == u64(6), "mixed");
});
export(main);
```

`yo check` (v0.2.62, and a develop build at 4d942f533) printed:

```
error[E0910]: `self` is lent exclusively to this call (it is a `&mut` argument, or it holds a `&mut` capture), and it reaches `self`, which `(self.tail)` in the same call also reaches (`(self.tail)`): the callee could reach one place through both.
   --> tmp/fixme.yo:15:5
   |
15 |     self._mix(self.tail);
   |     ^^^^
help: split the call, or pass the place through the closure alone (call arguments are exclusive, decisions 28 and 38 B)
```

Move `_borrow_first` below the `impl` (or delete it) and the same program
is accepted: a method body is checked where its definition is reached, and
the check only runs once a borrow has been recorded.

## Cause

`require_capture_borrow_exclusivity` (`src/evaluator/utils.yo`), decision
38 B's argument-overlap test, is gated on `capture_borrows_exist()`: a global
that turns true the first time any capture list records a `&`/`&mut` entry
(`register_capture_borrows`, `src/types/utils.yo`). Before that the check
is skipped entirely, which is why develop accepted `std/hash.yo` and the A5
tree, whose std/async/std/fs/std/net changes add borrowing capture lists
that are evaluated before `std/hash.yo`, did not. No single A5 file was the
cause; any one of them arms the gate.

Once armed, `_arg_places` counted the place each argument names, by field
chain, for every argument, including a by-value argument of a `Copy` type.
`self.tail` named the place `self.tail`, which overlaps the `&mut self`
receiver, so E0910 fired. But a by-value `Copy` argument is copied before the
call runs: the callee gets a fresh value and cannot reach the place.
`require_ref_own_argument_exclusivity` (`src/types/flowability.yo`) already
exempts exactly this case ("a by-value argument with nothing to transfer ...
is copied"), and the two-phase-borrow rule for later arguments (a read
passes, `xs.push(xs.len())`) agrees.

## Fix

`require_capture_borrow_exclusivity` no longer counts the named place of an
argument bound to a by-value parameter whose type is bitwise `Copy` and not
second-class. The borrows that argument's type carries (a capture list's
entries) still count, and a ref argument, a non-`Copy` by-value argument
(`self.take(self.name)` moves a field out of a lent place), a second-class
value (a `&T`, a borrowing closure) and the called closure value keep their
named places. Nothing special-cases `std/hash.yo`.

The PR `fix/e0910-holes` (E0910 lend-move holes) edits
`_check_call_lent_place_moves` in `src/evaluator/calls/function.yo` (the
moved/overwritten/relent-place check), a different function; it does not
touch this one.

Test: `tests/closure_capture_list.test.yo`, "exclusivity: a by-value Copy
field read does not overlap the lent receiver" (an arming helper sits above
the `impl` so the method body is checked with the gate armed).
