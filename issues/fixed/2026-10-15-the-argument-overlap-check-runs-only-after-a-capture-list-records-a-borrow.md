# The argument overlap check runs only after a capture list records a borrow

**Severity:** S2 — whether E0910 reported two arguments that merely name overlapping places depended on what had been evaluated before the call: a valid program (`self.m(self.tail)` with a `u64` field) was rejected in any module checked after some capture list recorded a borrow, and the same holds for `f(&h, &mut h.n)`, which develop accepts everywhere else

**Found:** 2026-10-15, on the A5 branch `feat/vbd-v3-async-a5`. At 91e8e87d1, `yo check src/version_cache.yo --std-path ./std` rejected `std/hash.yo`'s `DefaultHasher._push_byte` (`self._compress(self.tail);`), which develop accepts. With that worked around (58adc48b5, `t := self.tail; self._compress(t);`), the A5 seed build failed on `src/evaluator/exprs/begin.yo` (`snapshot_loop_flow(&brk_lc, &mut brk_lc.break_states, …)`) and then `src/main.yo` (`compile_module(…, &mut ctx.expr_info_table, …, &ctx, …)`), two overlaps that develop's build, with the same seed, accepted.
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

The other direction. With no capture list anywhere, this is accepted:

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

`require_capture_borrow_exclusivity` (`src/evaluator/utils.yo`) is decision
28's argument exclusivity for capture-list borrows (decision 38 B, #1259): an
exclusive argument (a `&mut` one, or a value carrying a `&mut` capture) may
not overlap what another argument reaches through a capture list. It starts
with the fast path `if(!capture_borrows_exist(), return)`.
`capture_borrows_exist()` is a global that turns true the first time any
capture list records a `&`/`&mut` entry (`register_capture_borrows`,
`src/types/utils.yo`) and never turns false.

The gate is sound for overlaps that involve a capture borrow: with none
recorded, there are none to find. But the check also compared the places two
arguments merely NAME (`&h` and `&mut h.n`, or the receiver `self` and
`self.tail`) and reported those too. That is decision 28's value-root rule,
which the plan schedules for V2b ("The value-root rule lands with V2b",
plans/VALUES_BY_DEFAULT.md decision 28 "Phase") and which develop does not
enforce. Two develop tests assert the current acceptance:
`tests/string/string.test.yo`'s `s.push_string(&s)` and
`tests/type_soundness.test.yo`'s `_p5_clobber(&mut x, &x)`. Because those
pairs went through the gated check, the unlanded rule leaked in for code
evaluated after the first borrowing capture list in the session, and only
there. Develop's std has no borrowing capture list, so develop never saw it. A5's
`std/async`, `std/fs/watch.yo` and `std/net/tcp.yo` add some, are evaluated
before `std/hash.yo`, and armed it for everything after them. That is why
reverting any single A5 file did not help: each one arms the gate.

A second defect sat underneath. `_arg_places` counted the place an argument
names for every argument, including one bound to a by-value parameter whose
type is `Copy`. That argument is copied before the call runs, so the callee
cannot reach the place. `require_ref_own_argument_exclusivity`
(`src/types/flowability.yo`) already exempts that case ("a by-value argument
with nothing to transfer ... is copied"), and decision 28 counts only a
`&mut` argument or a by-value MOVE as a conflict. It matters for capture
overlaps: `acc.run_copy({ t : &mut acc.total }() => …)` with a by-value
`Copy` receiver was rejected.

## Fix

- An overlap is reported only when a capture borrow is one side of it
  (`_ArgPlace.from_capture`). Two named places are left to V2b's value-root
  rule, so `self._mix(self.tail)` and `f(&h, &mut h.n)` are accepted in every
  module, as develop accepts them. With that restriction, the
  `capture_borrows_exist()` gate decides nothing but speed, so it stays.
- An argument bound to a by-value parameter (`param_is_owning`) whose type is
  bitwise `Copy` and not second-class no longer contributes the place it
  names; the borrows its type carries still count. A `&T` argument keeps its
  place. The exemption keys on `param_is_owning`, not `!param_is_ref`,
  because `param_is_ref` marks only `&mut`: keyed on `!param_is_ref` it would
  also exempt `f(&acc, { t : &mut acc.total }() => …)`. Both call paths now
  pass the owning flags.
- V2b pre-work: the two compiler sites the A5 seed build reported are split
  the way A5 splits them, so the hunks are identical and A5 rebases cleanly.
  `snapshot_loop_flow` returns its snapshot and the caller pushes it onto
  `break_states`/`continue_states`. `run_compile` passes the expr-info table
  to `compile_module` through its own handle (an `ExprInfoTable` is a newtype
  over an `Rc`, so the copy shares the table) and writes it back after the
  call.
- `tests/closure_capture_list.test.yo`'s `_ClAcc.run` has taken `self : Self`
  since the by-value flip, so its "receiver versus a `&mut` capture" case had
  become a by-value `Copy` receiver. `run` now lends `self : &Self`, which is
  still rejected, and a new `run_copy` covers the by-value case, which is
  accepted.

Nothing special-cases `std/hash.yo`.

Landing the value-root rule instead (dropping the gate and reporting named
pairs everywhere) was measured. `check ./src` reported exactly the two sites
above, and `check ./std` reported nothing. In the language suite, it failed
`string.test.yo` and `type_soundness.test.yo` on the two tests named above,
and on no other E0910. (The suite's other failures, E0901 in `tests/http/*` and `tests/spawn_blocking.test.yo`, failed the same way on a build without this change.) That is V2b's change, together with those two tests and
`docs/*/FLOWABILITY.md`'s "+1 keep-alive" paragraph.

The PR `fix/e0910-holes` (E0910 lend-move holes) edits
`_check_call_lent_place_moves` in `src/evaluator/calls/function.yo`, the
check for places a later argument moves, overwrites or relends. That is a
different function, and the PR does not touch this one.

Test: `tests/closure_capture_list.test.yo`, "exclusivity: a by-value Copy
field read does not overlap the lent receiver". An arming helper sits above
the `impl`, so everything after it is checked with capture borrows present.
The test asserts that `self._mix(self.tail)`, `f(&mut h, h.tail)`, the
by-value `Copy` receiver against a `&mut` capture, and `f(&h, &mut h.state)`
are accepted, and that a `&` capture against a `&mut` argument is still
rejected.
