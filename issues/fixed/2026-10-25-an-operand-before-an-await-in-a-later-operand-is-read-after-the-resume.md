# An operand before an `await` in a later operand is read after the resume

**Severity:** S1 — inside an `io.async` body, `sub(x, io.await(f(&mut x, io), io))` passes the value `x` has after the awaited future wrote it; a by-value read of a `&mut` capture in the same position is copied into a C local that a real suspension leaves uninitialized.

**Status:** FIXED 2026-11-10 (codegen; local-slot and operator shapes). Found 2026-10-25 while fixing
`issues/fixed/2026-10-25-an-rc-field-operand-is-read-after-a-later-argument-releases-the-handle.md`
and `issues/fixed/2026-10-25-a-by-value-operand-is-read-after-a-later-mut-argument-writes-it.md`.
That fix (`sequence_operand`, `src/codegen/exprs/other_fn_call.yo`) copies an earlier operand into a
C local before a later operand's statements run. Inside a state machine it leaves the operand alone
when a later operand awaits, because a C local declared before the suspension is not restored by the
resume. This is that case.

## Reproducer

`issues/repros/2026-10-25-an-operand-before-an-await-in-a-later-operand-is-read-after-the-resume.yo`,
built with `--std-path ./std --sanitize address --allocator system`:

```yo
{ assert } :: import("std/assert");
{ yield } :: import("std/async");
sub :: (fn(a : i32, b : i32) -> i32)(a - b);
slow :: (fn(p : &mut i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ &mut p }(io : Io) => {
    io.await(yield(io), io);
    p = i32(10);
    i32(1)
  })
);
main :: (fn(io : Io) -> unit)({
  r := io.await(
    io.async((io : Io) => {
      (mut(x) : i32) = i32(3);
      sub(x, io.await(slow(&mut x, io), io))
    }),
    io
  );
  assert(r == i32(2), "x is read before the await that writes it");
  ()
});
export(main);
```

```
x is read before the await that writes it (at …/std/assert.yo:39:17)
```

## Root cause (from the emitted C)

The two shapes differ only in where the earlier operand lives.

1. A local of the `io.async` body lives in a state-machine slot. The plain-call argument loop leaves
   the slot read inline, so it runs after the resume:

   ```c
   // __yo_resume_1: the await of slow(&mut x) completed, x is now 10
   int32_t tmp_sub = sub_fn((int32_t)(sm->var_x_…), (int32_t)(tmp_await));
   ```

2. A `&mut` capture read by value is materialized by `_materialize_arg` into a C local before the
   await, `int32_t __yo_v_y = (*sm->__capture.__yo_v_y);`. That is the right order, but the local is
   declared in the resume function, and a resume through the dispatch switch jumps past its
   initialization: after a real suspension the call reads an uninitialized local. With an `Rc`
   capture the same shape would pass an uninitialized pointer.

Both need the earlier operand's value held in a state-machine slot across the suspension. The slots
are laid out by the await analysis before codegen runs, so codegen cannot add one on demand.

## Fix direction

Have the await analysis (`src/evaluator/async/`) give each operand that precedes an await in a later
operand of the same call, operator or literal its own slot, and have `sequence_operand` and
`_materialize_arg` store the copy there (`_store_temp_var_to_state_machine_if_needed`) and read it
back after the resume.

## Fix (2026-11-10)

`collect_operand_holds` (`src/codegen/exprs/async.yo`) walks an `io.async` body (the same boundaries as
`expr_contains_await`, following macro expansions) and lays out one struct field `__yo_seq_<expr id>` per operand
that precedes a later operand containing an `await`, typed by `operand_hold_type` (`other_fn_call.yo`, the one place
`sequence_operand` decides the copy's type). The set of ids reaches the resume function through
`FunctionGenerationContext.sm_operand_holds`. In a state machine, `sequence_operand` no longer returns the operand
inline when a later operand awaits: when `must` holds and a slot was laid out for the operand, it stores the value
into `sm->__yo_seq_<id>` before the suspension and uses that slot as the operand's code. An operand without a laid-out
slot keeps the old behavior (a missed shape degrades to the old bug, never to a missing field).

Test: `tests/async/sm_shapes_4.test.yo` "an operand before an await in a later operand is read before the await"
(call argument and operator over an `io.async` local; fails on a develop-built compiler with rc 6, passes after).

Not covered by the test: the second shape above, a `&mut` capture read by value (its `_materialize_arg` C local is now
also routed through the slot, but the repro's `{ &mut p }` capture spelling no longer type-checks since E0926, so the
shape lacks a reproducer under the current reference rules).
