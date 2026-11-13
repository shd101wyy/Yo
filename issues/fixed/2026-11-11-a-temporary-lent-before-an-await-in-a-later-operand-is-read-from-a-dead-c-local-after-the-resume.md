# A temporary lent before an await in a later operand is read from a dead C local after the resume

**Severity:** S1. Inside an `io.async` body, `use2(&make(), io.await(num(io), io))` compiles to a call that, after
a real suspension, passes the uninitialized C local the temporary was first evaluated into: ASan reports a
garbage allocation size ("requested allocation size 0x140000000000 … exceeds maximum supported size") when the
callee formats the string. A miscompile of a well-typed program; also the temporary-receiver and `match(&temp, …)`
forms. v0.2.76 accepts the program as well (check rc 0).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A53). Confirmed on develop `64f33c710`. The fixed sibling
`issues/fixed/2026-10-25-an-operand-before-an-await-in-a-later-operand-is-read-after-the-resume.md` (#1898, in
`64f33c710`) gives a BY-VALUE operand before a later await its own task slot; a LENT operand is excluded from it.

## Reproducers

`issues/repros/2026-11-11-a-temporary-lent-before-an-await-in-a-later-operand-is-read-from-a-dead-c-local-after-the-resume.yo`
(positive, must run clean):

```yo
make :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
num :: (fn(io : Io) -> Impl(Future(usize, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    usize(7)
  })
);
use2 :: (fn(a : &String, b : usize) -> usize)({
  println(`OUT: ${a.*}`);
  (a.len() + b)
});
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => use2(&make(), io.await(num(io), io)));
  println(`OUT: ${io.await(f, io).to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: requested allocation size 0x140000000000 (…) exceeds maximum supported size of 0x10000000000 (thread T1)
```

The emitted resume function (probe `l01`; `__yo_t_17030455559196638567` is `String`, `yo_id_3362…` is `use2`):

```c
  __yo_t_17030455559196638567 _file____home_temp_121373572256215761690 = yo_id_9741192430425894859000000();
  sm->var__file____home_temp_121373572256215761690_15610737778489618409 = _file____home_temp_121373572256215761690;
  /* ... the await of num(io): state = 1, return ... */
      __yo_resume_1: ;
  /* ... */
  size_t _file____home_temp_127863406654686886860 = yo_id_3362087049435722944000000(_file____home_temp_121373572256215761690, (size_t)(_file____home_temp_139772195106428683641));
yo_id_4683339436075136311000000(&(sm->var__file____home_temp_121373572256215761690_15610737778489618409));
```

The temporary IS copied into a state-machine slot (`sm->var_…`, which the drop after the call reads), but the
argument is the C local, which a resume through the dispatch switch jumps past.

- `…-receiver.yo` (positive): `mkw().plus(io.await(num(io), io))`, a temporary receiver of a `self : &Self` method.
- `…-match.yo` (positive): `match(&mk_opt(), .Some(r) => { io.await(yield(io), io); println(r.*) }, …)`.
- `…-pos.yo` (positive control): `n := io.await(num(io), io); use2(&make(), n)` runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict |
| --- | --- |
| `use2(&make(), io.await(…))` | accepted, garbage read after the resume (ASan) |
| `mkw().plus(io.await(…))`, temporary receiver | accepted, the same |
| `match(&mk_opt(), .Some(r) => { await; r.* })` | accepted, the same (ASan allocation-size-too-big) |
| `P2(a : make(), b : io.await(…))`, an OWNED temporary before the await (probe `l03`) | runs clean |
| `(make(), io.await(…))` tuple (probe `l07`); `make() == io.await(fs(io), io)` (probe `l13`) | runs clean |
| `for(&mk_list(), s => { await; s.* })` (probe `l06`) | runs clean |
| `io.await(show(&make(), io), io)`, a lent temporary inside the awaited call (probe `l08`) | runs clean |

## Root cause

`collect_operand_holds` (`src/codegen/exprs/async.yo`, #1898) lays out a `__yo_seq_<id>` slot for each operand
that precedes an operand containing an await, and `sequence_operand` (`src/codegen/exprs/other_fn_call.yo`) stores
the operand there. `_collect_operand_holds_list` skips lends on purpose:

```yo ignore
skip := (ast_expr_is_address_of_call(&op, Option(usize).Some(usize(1))) || ast_expr_is_fn_call_of(&op, BK_BORROW_MUT, …) || …);
```

A lend of a NAMED place is safe to re-read after the resume (the place lives in a slot). A lend of a temporary is
not: the temporary's value is evaluated into a C local, copied into the temporary's state-machine slot for its
drop, and the argument expression is still the C local's name. The receiver and scrutinee forms take the same path
through an implicit `&`.

## Expected

The program prints the string and `OUT: 79`. A lent temporary that precedes a later await must be read from its
state-machine slot after the resume, as the fixed sibling does for a by-value operand: either the hold walk keeps
`&temp` (and `&mut temp`) operands, or a lent temporary that already has a `sm->var_…` slot is read from that slot
instead of from its C local.

## Test

With the fix: the three positives and the control become cases in `tests/async/sm_shapes_4.test.yo`, beside "an
operand before an await in a later operand is read before the await", each run under ASan in CI's sanitizer job.

## Fix

Fixed 2026-11-13 (branch `fix/c8-codegen-ownership`), the doc's second direction: a temporary that has a task slot is
read from the slot.

- A call argument passed by value (a small `&T` or `&Self` parameter takes its referent's bits) goes through
  `_sm_lent_temp_slot` in `_apply_ref_amp`'s by-value branch, as the address branch already did for a pointer
  parameter. Every call path (plain calls, method dispatch, receivers) renders its arguments there.
- A borrowing `match` over a temporary (any mode but the consuming one) switches on, and binds into, the temporary's
  slot (`src/codegen/exprs/match.yo`), so an arm binding read after an await points into the task, not into the
  resume function's dead C local.

The slot holds the value the C local was initialized with (`_store_temp_var_to_state_machine_if_needed` stores it
right after the declaration), so reading it is equivalent where no await intervenes.

**Regression test:** `tests/async/sm_shapes_4.test.yo`, "a temporary lent before an await in a later operand is read
after the resume": the argument, receiver and scrutinee forms and the control (an ASan failure before the fix).
