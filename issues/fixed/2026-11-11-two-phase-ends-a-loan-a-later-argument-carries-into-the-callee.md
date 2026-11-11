# Two-phase borrows end a loan that a later argument carries into the callee

**Severity:** S1 — a soundness regression since v0.2.76: `yo check` accepts a call that lends a place `&mut` while another operand of the same call hands the callee a `&` loan of that place, and the element form is a heap-use-after-free at run time. The v0.2.76 seed rejects every form with E0911.

- Filed: 2026-11-11. Found by the borrow/ownership audit (yo-6c, probes `p2`–`p5`, `q5b`–`q5d`); fixed on `fix/p9-holder-arg` (lane p9fix).
- Introduced by #1861 (P9, two-phase borrows with a named `&`, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7).

## Reproducer

```yo ignore
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p)));
grow_then_read :: (fn(generic(p : Origin), xs : &mut ArrayList(i32), h : H(p)) -> i32)({
  mut(i) := usize(0);
  while(i < usize(1000), {
    xs.push(i32(7));
    i = (i + usize(1));
  });
  h.r.*
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  h := H(xs)(r : &xs(usize(0)));
  v := grow_then_read(&mut xs, h);
  ()
});
```

Develop accepts it. Compiled with `--sanitize address --allocator system`, the call reads `h.r` after the pushes have reallocated
`xs`'s buffer: `heap-use-after-free`. The same hole, every form accepted by develop and rejected by v0.2.76 with E0911:

- the reference passed bare, in either order: `r := &x; read_clr(&mut x, r)`, `clr_read(r, &mut x)`, `a := idr(&x); clr_read(a, &mut x)`;
- a holder or an `Option(&T)` passed by value: `h := Option(&Rc(X)).Some(&x); replace_then_read(&mut x, h)`;
- a nested call's reference result over a named loan: `q := &xs; f(&mut xs, first(q))`.

## Root cause

P9 judges a `&mut` argument twice: where it is written (a read) and at the call's activation, past its last token (a write).
`_local_borrow_access_live` (`src/evaluator/utils.yo`) judged the activation write against the borrows whose live range runs past
the call's last token only, so a borrow whose last use is ANY operand of the call counted as ended. That is right only when the
operand's value carries no origin of the loan (`xs.push(i32(r.len()))` passes an `i32`). An operand whose value is the reference, a
holder of it or a reference derived from it hands the loan to the callee, which then runs with the loan live beside the `&mut`.

The reference model (`tests/origins/model.yo`, `eval_call`) had the same gap: it activated against `outer_after` alone.

## Fix

`d3_check_pending` (`src/evaluator/exprs/assignment.yo`) collects the call's operands whose value carries an origin
(`call_origin_operands`: an argument that is a `&`/`&mut` lend or whose type, as passed, carries an origin; a method call's receiver;
a callee that is a value). At the activation, `_lb_live_at_activation` keeps a borrow live when it is live past the call or when it is
live where the `&mut` argument is written and one of those operands mentions it. So P9 still ends a loan whose last use is an operand
that carries no origin (`xs.push(i32(r.len()))`, `push_n(&mut xs, h.r.len())`), and every form above is E0911 again, as in v0.2.76.
The model's activation live set adds the uses of every argument whose type carries an origin.

Regression rows: `tests/local_borrows.test.yo` (`two_phase_*_argument_rejected` and the holder-value control), corpus rows
`two-phase-holder-arg`, `two-phase-option-arg`, `two-phase-ref-result-arg` (E0911) and `two-phase-holder-value-arg` (accept) in
`tests/origins/corpus.tsv` and `tests/origins/model_corpus.test.yo`, and the G-B pair
`tests/origins/unsound/p9-two-phase-holder-argument{,-pos}.yo`.
