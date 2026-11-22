# A future-origin stamp dropped the places a combinator's operands lend

> Found 2026-11-21 as develop's red battery (run 44866017559 on `bb237b871`):
> `tests/async/combinators.test.yo` failed to compile as a batch, so all 76 of
> its tests showed ✗ and the wasm and forced-epoll jobs went red. Filed by the
> `fix-combinators` lane. **FIXED same day** (moves to `issues/fixed/` with the
> fix).

**Severity:** S2 — a program that writes a place a live combinator future
borrows `&mut` through its operand passed `yo check` (wrongly accepted), and
the rejection that still fired named the wrong rule (decision 28's general
call-argument loan instead of decision 38 B's combinator overlap), breaking
the test file's compile.

## The symptom

Two rows of `tests/async/combinators.test.yo`'s A4 family flipped after #2020
(`7373bbbc3`, merged between the last green battery `c36523d8e` and the red
one). The batch compile failed on the first one:

```text
Expected text: two operands of one combinator may not reach one place with an exclusive side
Raised: This argument lends `&mut` `c`, which the value of an earlier argument of the same call borrows with `&mut` (`_a4_bump_after(&mut(c), u64(1), io)`): an argument's value is a loan the call holds from its evaluation until the call returns, ...
```

for the row

```yo
comptime_expect_error(
  io.await(_a4_with(_a4_bump_after(&mut c, u64(1), io), &mut c, io), io),
  "two operands of one combinator may not reach one place with an exclusive side"
);
```

(`_a4_both`-shaped rows — a combinator whose future borrows nothing of its
own — kept the right diagnostic; only `_a4_with`/`_a4_with_first`-shaped ones,
whose callee ALSO borrows a parameter of its own, flipped.)

The same root cause opened a soundness hole, reproducible standalone:

```yo
_a4_with :: (fn(generic(T : Type), op : Impl(Future(T, Io)), c : &mut _A4Counter, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ op, c : &mut c.* }(io : Io) => {
    c.n = (c.n + i32(10));
    io.await(op, io);
    ()
  })
);
main :: (fn(io : Io) -> unit)({
  mut(c) := _A4Counter(n : i32(0));
  mut(d) := _A4Counter(n : i32(0));
  f := _a4_with(_a4_bump_after(&mut d, u64(9), io), &mut c, io);
  d.n = i32(5); // accepted after #2020; v0.2.79 rejects it
  io.await(f, io);
});
export(main);
```

- seed v0.2.79: `error[E0911]: Cannot write `d.n` here: `f` borrows `d` with
  `&mut` and is still live, ...`
- after #2020 (verified with a binary built from `7373bbbc3`): `evaluator OK`
  — the write to the place the operand lends `&mut`, while the combinator's
  future holds it, is accepted.

## Root cause

#2020 added the R-CALL stamp to `_note_future_producing_call`
(`src/evaluator/calls/function.yo`): when a call's callee has a recorded
future-result origin (`fn_future_result_origins`, written by
`_note_fn_future_result_roots`), the call's result type is stamped with the
recorded parameter names through `_stamp_future_origin`, which REPLACED the
`FutureTraitT` bound's origin with exactly those names.

The record only keeps roots whose names resolve to parameters of the callee
itself — and the roots a borrowing OPERAND contributes are spelled through the
operand parameter (`op`), not the operand-maker's parameters, so no record ever
names them (a `YO_DEBUG_N2B=1` trace shows `[c]`/`[self]` records only). The
combinator's future type, as built by the `io.async` machinery, DOES spell the
operand parameter in its origin (§3.13 A4: "the function's future then borrows
what its operands borrow"). The replace-stamp wrote `{c}` over `{op, c}` and
dropped `op`.

Every reader of the call result's origin then lost the operand's places:

- `_check_future_operand_lends` gates operand recognition on
  `_borrows_root_named(bs, label)`; with `op` gone from `bs`, the operand is
  not recorded, `any_operand` stays false and decision 38 B's check returns —
  the general `_check_call_value_loans` (O3 step 2, #1938) then reports the
  generic message. The order comment in `_note_future_producing_call`
  ("Operands first: ... which the general later-argument rule would otherwise
  report as a two-phase conflict") states the intended priority; the stamp
  broke the input it depends on.
- the binding freeze (`Cannot write `d.n` here`) and the spawn rejection read
  the same origin, so the operand-lent place stopped being frozen — the
  soundness hole above.

#2028 (`a3bb8c99b`, capture-list loans) is NOT involved: the flip and the hole
both reproduce on a binary built from `7373bbbc3` alone.

## Fix

`_stamp_future_origin` now UNIONS the stamped names with the origin names the
`FutureTraitT` bound already spells: a stamp adds places, it never drops them.
The operand-forwarded roots stay beside the callee's recorded parameters —
both are facts about one future — so decision 38 B's overlap check sees the
operand again and fires first with its specific diagnostic, and the freeze and
spawn checks keep the operand's places. #2020's forwarded-future rows are
unaffected: their pre-stamp origin spelled nothing (that was the S1 #2020
fixed), so the union degenerates to the recorded names there.

## Verification

- `tests/async/combinators.test.yo` compiles as a batch again and all 76
  tests pass (was: batch compile failure, 76 ✗).
- A regression row in the "A4: a combinator over a borrowing future is itself
  second-class" test: binding `_a4_with(_a4_bump_after(&mut c, ...), &mut d,
  io)` and writing `c.n` must raise `Cannot write `c.n` here`. Before the fix
  the write was accepted, so the row failed; after it the row passes.
- The standalone repro above is E0911 again under the tree binary.
