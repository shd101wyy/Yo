# A later argument can overwrite the place an earlier argument lends to a plain call

**Severity:** S1 — a `&x.f` argument is read before the later arguments run,
so a later argument that overwrites `x` (or lends it `&mut` to code that does)
drops the value the callee then reads: a use after free in an accepted
program.

Filed 2026-10-13 as a design question by the fix of
`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-a-call.md`
("may a later argument overwrite or `&mut`-relend a place an earlier argument
lends to a plain call?"). The v0.2.62 adversarial review (2026-10-14) showed
that the recommendation it carried, keep both accepted, was unsound, so it is
resolved here as a bug. The defect predates v0.2.62: v0.2.61 behaves the
same.

## The question as filed

A call's arguments are evaluated in order, so a place lent by an earlier
argument (`&x`, `&mut x`, `&mut x.f`, the receiver of a `&self`/`&mut self`
method) is borrowed while the later arguments run. A later argument can

1. **move** its root binding (`syncf(&mut a, eat(a))`);
2. **overwrite** it (`syncf(&mut a, { a = Res(n : i32(10)); i32(1) })`);
3. **lend it `&mut` again** (`syncf(&mut a, reset(&mut a))`, or call a
   `&mut self` method on it).

Case 1 was rejected with E0910 for every call; a call that makes a borrowing
future rejected all three (§3.13 A2). For a plain call, cases 2 and 3 were
accepted on the argument that "both finish before the callee runs, and Yo's
call lowering materializes `&x` as the address of a place that outlives the
call, so the callee sees the new value". `docs/en-US/FLOWABILITY.md` said the
same.

## Symptom

That argument holds for a whole variable lent `&mut`, which is lowered as an
address taken late. It does not hold for a field path lent to a `&T`
parameter:

```yo ignore
P :: struct(s : String, k : i32);
peek :: (fn(c : &String, k : i32) -> usize)(c.len());
reset :: (fn(q : &mut P) -> i32)({
  q.s = String.from("y");
  i32(0)
});
main :: (fn() -> unit)({
  p := P(s : String.from("hello world, a long string that is heap allocated"), k : i32(0));
  x := peek(&p.s, {
    p = P(s : String.from("x"), k : i32(1));   // accepted
    i32(0)
  });
  y := peek(&p.s, reset(&mut p));              // accepted
  println(`x=${x} y=${y}`);
});
```

Both calls were accepted and printed `x=0` (neither 49 nor 1): `peek` read a
`String` whose buffer the later argument had already released. With a `Drop`
payload in place of the `String`, the callee read the old value after its
destructor ran (`callee: reads Fd id=7; ids already dropped=7`). A tuple field
(`&xs.0`) and a field behind a `ref(struct)` root behaved the same.

## Root cause

Codegen copies a field-path value bound for a read-only `&T` parameter into a
temporary when it evaluates that argument, before the later arguments run.
The emitted C for the first call is, in order:
`tmp = __yo_v_p.__yo_v_s;`, then the block's assignment of the new `p` with
`__yo_decr_rc(old.__yo_v_s)`, then `peek(tmp, ...)`. The old value is dropped
between the snapshot and the call. So the borrow does start when the argument
is evaluated, as in Rust; what was missing is the rule that follows from it.

## Fix

The rule is now Rust's two-phase borrow rule, for every call: **an argument's
borrow starts when that argument is evaluated and lasts until the call
returns, so a later argument may not move, overwrite, or lend `&mut` a place
an earlier argument lends.** A read of the place, or a `&` relend of it, in a
later argument stays accepted (`xs.push(xs.len())`, `f(&mut a, a.plus(1))`),
and so does a write to a field the lent place does not overlap
(`f(&p.s, { p.k = 3; k })`).

Rejecting only the field-path overwrite was not enough: a `&mut` relend
(`peek(&p.s, reset(&mut p))`) performs the overwrite inside the callee it
lends to, so that form must go too. Changing the lowering so that a field-path
argument is read late would have kept cases 2 and 3 sound for this one
lowering, but it would leave the language rule depending on codegen detail,
and it would keep accepting code that reads as if `f` got the old value. The
borrowing-future rule already rejects all three; the plain-call rule now
matches it.

`_check_call_lent_place_moves` (`src/evaluator/calls/function.yo`) calls
`_check_call_lent_place` for each lent place (the receiver of a borrowing
method, each `&x`/`&mut x` argument, each operand an operator's method
borrows). After the move check, it runs `_find_lent_place_access`, written for
the future rule, over the later arguments, and an overwrite, a `&mut`, or a
`&mut self` method call on an overlapping place is E0910 with the plain-call
message ("the borrow starts when that argument is evaluated and lasts until
the call returns"). A call that makes a borrowing future is still checked
first by `_check_future_call_argument_conflicts`, so its §3.13 A2 message is
the one reported (`tests/async_await.test.yo` now pins that message). A root
in `_lent_roots_moved_before` (only `yo fix --migrate match-scrutinee` reaches
one) skips both checks, as it skipped the move check.

Run over the tree with the tree-built compiler (a temporary report mode that
listed every site instead of stopping at the first one per module, so sites
inside closure bodies were seen too):

- `std/`: none.
- `src/`: six, all the Rust-rejected shape of two borrows of one place in one
  call, none a use after free today. `src/parser.yo` called a `&mut self`
  method with an argument that called another `&mut self` method
  (`self.token_starts_prefix_operand(self.skip_ws_fwd(i))` twice, and
  `self.parse_primary_end(.FnCall(self.alloc_id(), …), …)` twice); each now
  computes the inner call into a local first. `src/evaluator/exprs/begin.yo`
  passed `&lc` and `&mut lc.break_states` (and `continue_states`) to
  `snapshot_loop_flow`; #1382 rewrote that function to return its snapshot,
  which removes both sites.
- `tests/`: one, `tests/async/fusion.test.yo` "prologue and argument effects
  run once, in order", whose argument pushed to the `&log` it also lent
  (`_logged(&log, _log_push(&mut log, 1), io)`). The argument now reads the
  log and counts its runs in a global, which checks the same order and
  run-once property.

Regression test: `tests/parameter_modes.test.yo`, "a later argument cannot
overwrite or relend the place an earlier argument lends" (the two
accepted-form asserts of the earlier test became rejections, and new asserts
pin the read, `&` relend and disjoint-field forms as accepted). Docs:
`docs/{en-US,zh-CN}/FLOWABILITY.md` "One call-site rule", the E0910 entry of
`yo explain`, and `plans/VALUES_BY_DEFAULT.md` decision 28's "As built" note.
