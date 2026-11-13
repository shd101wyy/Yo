# A temporary argument leaks when a later argument returns, continues or unwinds

**Severity:** S2. In `two(mk(), cond(c => { return(usize(0)); }, true => mk()))` the first argument is evaluated
into a temporary, then the second argument returns: nothing drops the temporary (LeakSanitizer: 34 bytes, one leak
per exit; the `Drop` count is 2 where 3 values were built). The same holds for a `continue` or an `unwind` in the
later argument, for a struct or tuple literal's earlier field, and for a temporary method receiver. A bounded leak
on the exit path only, with no use-after-free or double free. Pre-existing: v0.2.76 accepts these programs.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A45). Confirmed on develop `64f33c710`. Related: the open
`issues/fixed/2026-11-03-an-unwind-out-of-a-later-argument-leaks-an-earlier-moved-argument.md` (a NAMED local and
`unwind` only) and the fixed `issues/fixed/2026-10-23-a-break-in-a-later-argument-skips-the-drop-of-a-by-value-argument.md`
(a named local and `break`; its fix also covers `return` and `continue` for a named local, measured below).

## Reproducers

`issues/repros/2026-11-11-a-temporary-argument-leaks-when-a-later-argument-returns-continues-or-unwinds.yo`
(negative: expects `accept`, drops=3 and no leak; the essential lines):

```yo ignore
D :: struct(s : String);  // Drop counts into g_drops
mk :: (fn() -> D)(D(s : String.from("payload-0123456789abcdefghijklmnop")));
two :: (fn(a : D, b : D) -> usize)(a.s.len() + b.s.len());
run :: (fn(c : bool) -> usize)(two(mk(), cond(c => { return(usize(0)); }, true => mk())));
main :: (fn() -> unit)({
  r1 := run(true);
  r2 := run(false);
  println(`OUT r2=${r2.to_string()} drops=${nd().to_string()} expect 3`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
OUT r2=68 drops=2 expect 3
==…==ERROR: LeakSanitizer: detected memory leaks
SUMMARY: AddressSanitizer: 34 byte(s) leaked in 1 allocation(s).
```

The emitted C for `run` (names shortened): the `return` inside the second argument releases nothing.

```text
D tmp_first = mk();
D tmp_second;
if (c) {
  size_t r = 0ULL;
  return r;                 /* tmp_first is never dropped */
}
else { … tmp_second = mk(); }
size_t res = two(tmp_first, tmp_second);
```

- `…-continue.yo` (negative): the same call inside a `while`, the second argument `continue`s; drops=2, LSan leak.
- `…-unwind.yo` (negative): the second argument's callee raises a `ctl` effect whose handler `unwind`s; drops=2,
  LSan leak.
- `…-pos.yo` (positive control): `x := mk(); two(x, cond(c => { return(usize(0)); }, true => mk()))`, the first
  argument a named local: drops=3, no leak.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| temporary first argument, `return` in the second | leak, drops=2 | drops=3 |
| temporary first argument, `continue` in the second | leak, drops=2 | drops=3 |
| temporary first argument, the second's callee unwinds | leak, drops=2 | drops=3 |
| struct literal `PP(a : mk(), b : cond(c => { return(…); }, …))` (ledger r15) | leak (34 bytes) | no leak |
| tuple literal `(mk(), cond(c => { return(…); }, …))` (ledger r16) | leak (34 bytes) | no leak |
| temporary receiver `T(d : mk()).eat(cond(c => { return(…); }, …))` (ledger r17) | leak (34 bytes) | no leak |
| named local first argument, `return` in the second | drops=3, clean | drops=3 |
| named local first argument, `unwind` in the second (the open 2026-11-03 doc; not re-measured) | leak (that doc) | no leak |

A `break` in the later argument with a temporary first argument was not measured.

## Root cause

The fixed 2026-10-23 doc's mechanism, for a shape its fix does not reach. A by-value argument's move is ordered at
the argument's own position, which precedes a later argument, though the call moves it only after every argument
is evaluated; an exit inside the later argument therefore counts as "after the move" and releases nothing.

- `return` / `break` / `continue`: the fix is `_m3_consumed_for_call_arg` (`src/evaluator/exprs/begin.yo`), which
  treats the variable as not yet moved inside a later argument only when an earlier argument is an ATOM spelling the
  variable's name at its move token. Verified by reading: a temporary's argument is a call (`mk()`), never an atom
  naming the temporary, so the exemption cannot fire. A temporary receiver sits in the `.` callee, which the walk
  visits with the unmodified `consumed`. Whether the temporary reaches the M3 driver at all (a frame variable with
  an `initialized_at_token`) was not traced: hypothesis.
- effect escapes and `unwind`: the open 2026-11-03 doc's gate, `generate_consumed_var_drops_for_escape`
  (`src/codegen/exprs/return.yo`), which skips a variable whose `consumed_at_token` precedes the escape point. The
  `if (__yo_effect_escaped) { return … }` after the second `mk()` drops nothing in the C above.

One fix covers both docs if it is made where the two paths agree: order a by-value argument's move (a named local's
or a temporary's, a field's of a struct or tuple literal, a receiver's) at the end of its call's argument list, which
is the 2026-11-03 doc's own fix direction, rather than widening the atom-only exemption.

## Expected

Accepted, and every value built is dropped exactly once on every path (ledger: "drops exact on all tested paths"
is the model's rule for named locals). An exit that leaves a call between its arguments releases each argument
already evaluated and not yet moved.

## Test

With the fix, the four programs move to `tests/origins/unsound/` (all `// expect: accept`, run with LSan), and
`tests/move_only.test.yo` gains "a temporary argument is dropped when a later argument returns / continues /
unwinds" beside the 2026-10-23 row, with the struct literal, tuple literal and receiver forms.

## Fix

Fixed 2026-11-13 (branch `fix/c8-codegen-ownership`). The hypotheses held, and one more step was missing.

- `return` / `break` / `continue`: `_m3_consumed_for_call_arg` (`src/evaluator/exprs/begin.yo`) asks
  `_m3_first_arg_after_move` which operands run after a by-value operand moved the variable. An operand moves it when it
  is an atom spelling a named local at its move token (as before), or the expression a TEMPORARY was minted for (its
  `initialized_at_token`; the move is the call's whatever token records it, a receiver's at the method call), and a
  labeled field counts as its value. A method call's receiver precedes every argument.
- The M3 driver skipped a temporary whose minting site precedes its block's own token: a one-statement body that is a
  method call carries the call's token, after its receiver. The driver now compares against the block's earliest token.
- effect escapes and `unwind`: the driver records the span of the operands after the moving one (`ArgMoveRegion`,
  `src/expr_info.yo`), and codegen's exit gate (`_variable_moved_before_cleanup_point`, `src/codegen/exprs/return.yo`)
  treats a cleanup point wholly inside it as before the move. This also fixes the named-local unwind doc,
  `issues/fixed/2026-11-03-an-unwind-out-of-a-later-argument-leaks-an-earlier-moved-argument.md`.

All four reproducers print `drops=3` and run clean under LeakSanitizer.

**Regression test:** `tests/move_only.test.yo`, "move-only: a temporary or named argument is dropped when a later
argument returns, continues, breaks or unwinds": the `return`, `continue`, `break` and `unwind` exits with a temporary
first argument, the struct literal, tuple literal and temporary receiver forms, and the named call and struct-literal
unwind cases, each counting the drops and their payload sum.
