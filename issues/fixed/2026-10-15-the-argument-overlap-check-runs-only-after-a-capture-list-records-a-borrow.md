# The argument overlap check runs only after a capture list records a borrow

**Severity:** S2 — decision 28's argument exclusivity (E0910) depended on what had been evaluated before a call: a valid program (`self.m(self.tail)` with a `u64` field) was rejected in any module checked after some capture list recorded a borrow, and a real overlap (`f(&h, &mut h.n)`) was accepted in any module checked before one

**Found:** 2026-10-15, on the A5 branch `feat/vbd-v3-async-a5`. At 91e8e87d1, `yo check src/version_cache.yo --std-path ./std` rejected `std/hash.yo`'s `DefaultHasher._push_byte` (`self._compress(self.tail);`), which develop accepts. With that worked around (58adc48b5, `t := self.tail; self._compress(t);`), the A5 seed build failed on `src/evaluator/exprs/begin.yo` (`snapshot_loop_flow(&brk_lc, &mut brk_lc.break_states, …)`) and then `src/main.yo` (`compile_module(…, &mut ctx.expr_info_table, …, &ctx, …)`), two real overlaps that develop's build, using the same seed, accepted.
**Status:** FIXED 2026-10-15.

## Symptom

A false positive. With a borrowing capture list evaluated first:

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

If `_borrow_first` is moved below the `impl` (a method body is checked where
its definition is reached) or deleted, the same program is accepted.

A missed conflict. With no capture list anywhere, this is accepted:

```yo
_Ctx :: struct(n : i32, states : i32);
_snap :: (fn(c : &_Ctx, s : &mut i32) -> unit)({
  s = (s + c.n);
});
main :: (fn() -> unit)({
  c := _Ctx(n : i32(1), states : i32(0));
  _snap(&c, &mut c.states);
});
export(main);
```

If a borrowing capture list sits above it, or this module is imported from one
that has one, it is rejected with E0910 (``(c.states)` is lent exclusively
... which `c` in the same call also reaches``).

## Cause

`require_capture_borrow_exclusivity` (`src/evaluator/utils.yo`) is the one
check that enforces decision 28's argument overlap for places: an exclusive
argument (a `&mut` one, or a value carrying a `&mut` capture) may not overlap
anything another argument reaches. It extends that rule to capture-list
borrows (decision 38 B), and it began with the capture-borrow fast path
`if(!capture_borrows_exist(), return)`. `capture_borrows_exist()` is a global
that turns true the first time any capture list records a `&`/`&mut` entry
(`register_capture_borrows`, `src/types/utils.yo`) and never turns false. The
fast path is sound for the parts of the check that read capture borrows, but
the overlap between two arguments' NAMED places (`&h` and `&mut h.n`) has
nothing to do with capture lists. So decision 28 held only for code evaluated
after the first borrowing capture list in the session. Develop's std has
none, so develop never enforced it. A5's `std/async`, `std/fs/watch.yo` and
`std/net/tcp.yo` add some, are evaluated before `std/hash.yo`, and armed it
for everything after them. That is why reverting any single A5 file did not
help: each one arms the gate.

Once the gate was armed, a second defect showed. `_arg_places` counted the place an
argument names (`self.tail`) for every argument, including one bound to a
by-value parameter whose type is `Copy`. That argument is copied before the
call runs, so the callee cannot reach the place.
`require_ref_own_argument_exclusivity` (`src/types/flowability.yo`) already
exempts that case ("a by-value argument with nothing to transfer ... is
copied"), and decision 28 counts only a `&mut` argument or a by-value MOVE as
a conflict.

## Fix

- The check runs on every call that has an exclusive argument; the global gate
  is gone. The other `capture_borrows_exist()` fast paths
  (`src/evaluator/calls/function.yo`, `src/evaluator/values/dyn.yo`) only
  look at capture borrows and stay.
- An argument bound to a by-value parameter (`param_is_owning`) whose type is
  bitwise `Copy` and not second-class no longer contributes the place it names;
  the borrows its type carries still count. A `&T` argument keeps its place.
  The exemption keys on `param_is_owning`, not `!param_is_ref`, because
  `param_is_ref` marks only `&mut`. Both call paths now pass the owning flags.
- The two real overlaps in the compiler are split the way the A5 branch split
  them. `snapshot_loop_flow` returns its snapshot and the caller pushes it
  onto `break_states`/`continue_states`. `run_compile` passes the
  expr-info table to `compile_module` through its own handle (an
  `ExprInfoTable` is a newtype over an `Rc`, so the copy shares the table)
  and writes it back after the call.
- `tests/closure_capture_list.test.yo`'s `_ClAcc.run` has taken `self : Self`
  since the by-value flip, so its "receiver versus a `&mut` capture" case had become
  a by-value `Copy` receiver, which reaches nothing. `run` now lends
  `self : &Self`, and a new `run_copy` keeps the by-value case, which is accepted.

Nothing special-cases `std/hash.yo`.

The PR `fix/e0910-holes` (E0910 lend-move holes) edits
`_check_call_lent_place_moves` in `src/evaluator/calls/function.yo`, the
check for places that a later argument moves, overwrites or relends. That is a
different function, and the PR does not touch this one.

Tests:

- `tests/closure_capture_list.test.yo`, "exclusivity: a by-value Copy field
  read does not overlap the lent receiver". An arming helper sits above the
  `impl`, so the method body is checked with capture borrows present.
- `tests/ref_field_borrow.test.yo`, "a `&mut` argument may not overlap another
  argument of the same call". This file has no capture lists, so the test
  failed before the gate was removed. It also checks that two `&` arguments may
  overlap.
