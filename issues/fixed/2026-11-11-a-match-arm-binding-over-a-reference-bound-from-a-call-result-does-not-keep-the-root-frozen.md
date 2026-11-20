# A `match` arm binding over a reference bound from a call result does not keep the root frozen

**Status: FIXED on `v0280/clusters` (VERDICTS-71 rule (c), 2026-11-20).** The wall the branch first carried, which
made a bare `&mut` reference binding scrutinee E0910, is removed. It closed nothing: `match(&mut r.*, …)`, the spelling
its help recommended, is the same program to the checker (`local_borrow_scrutinee_source` cuts a place at `.*`). The
wall's own fixture, respelled that way, passed `check` and was a heap-use-after-free (VERDICTS-71 p9, p3). The fix
registers each place binding of a `&mut` match as an exclusive local borrow of the scrutinee's place, derived from
the local borrow it is reached from, in either spelling (`src/evaluator/exprs/match.yo`, the `mut_places` arm loop).
Parameters were already registered this way. Two refinements keep decision 25's re-point walk legal:

- the re-point's name is no access of `cur`'s place (`evaluate_local_borrow_repoint`);
- `local_borrow_require_no_live_derived` skips the binding the re-point goes through, unconditionally: the re-point
  freezes it whole for `cur`'s live range, so a later mention is E0911 while `cur` lives (VERDICTS-71 addendum B).
  A binding that one is derived from (a nested walk's outer `n`) is skipped only when its last mention is inside the
  right-hand side, because nothing freezes it.

The binding's own loan of `cur`'s place is not ended at the re-point. It runs to the binding's last mention, extended
by borrows derived from it, and it is what rejects b1 (`d := &n.next; cur = &mut n.next; cur.* = .None; use(d)`)
and b2 (`cur = &mut n.next; l1.head = .None; n.value = i32(7);`, a memory error before the fix).

`local_borrow_scrutinee_source` reads a binding's pattern source first, so a nested walk's re-point still names
`cur`.

While a binding lives, `cur` is reached only through it. A write, read or call through `cur`, or a write to `cur`'s
root, is E0911 with the existing text ("Cannot write `cur` here: `n` borrows `cur` with `&mut`…"). This covers a
local and a parameter alike, including r2: a `&mut` parameter matched bare with a nested `&mut` match over its
binding, which was accepted and a heap-use-after-free. G-B rows, each bare and spelled
(`tests/origins/unsound/a3-*.yo`):

- E0911: the wall fixture (m20) with its `.None` arm added, the write through `cur` (p3), the read through `cur` (q5),
  the root write (q7), `cur` passed to a `&mut` parameter (r6), the variant switch (m04), and r2.
- Accepted and ASan-clean: the walk, the two-step walk, the walk over a parameter's referent, and the write after the
  binding's last use.

`check ./src` and `check ./std` stay green without the parameter exclusion the wall needed for `std/log.yo`.

VERDICTS-71's p5 probe ("same text" for the pinned walk diagnostics) was measured before rule (c). On the rule-(c)
tree, two pinned cases in `tests/local-borrows.test.yo` fire one statement earlier: `d := &cur.*` under a live arm
binding is now the read-through E0911 ("Cannot read `cur.*` here: `n` borrows `cur`"), for the plain list and its
`Box` twin. Decision 38 A's "Cannot re-point `cur` here" is pinned twice. New twins take the derived borrow outside an
arm. A sibling binding inside an arm is pinned too, through self-recursion via a generic constructor
(`Pair(T) = enum(Two(l : Option(Box(T)), tag : i32))`, `PNode :: struct(v, kids : Pair(Self))`): sib1 is
"Cannot re-point `cur` here: `tag` borrows from `cur`'s current target", and sib2 (no later use of `tag`) is accepted.

Known conservative rejections, all sound and all accepted by Rust (a2, a7, c2, the sibling case, and b3's message)
are tracked as one S3 family in
`issues/2026-11-21-a-re-point-through-a-match-binding-keeps-the-binding-and-the-cursor-exclusive-longer-than-needed.md`
(VERDICTS-71 addendum 2: a loan per definition of `cur` is the fix, not a separate freeze range).

G-B rows for the addendum: `a3-repoint-in-loop-binding-write.yo` (a3), `a3-nested-repoint-ancestor-write.yo` (a5),
`a3-conditional-repoint-binding-write.yo` (a6), `a3-repoint-write-through-cur-then-binding.yo` (a7),
`a3-repoint-derived-shared-then-drop.yo` (b1), `a3-repoint-root-write-then-binding.yo` (b2),
`a3-nested-repoint-binding-read.yo` (b3), `a3-repoint-live-sibling-binding.yo` (sib1, all E0911) and
`a3-repoint-live-sibling-binding-pos.yo` (sib2, accepted), `a3-repoint-then-binding-write.yo` (a2, E0911) with its
`-pos` twin (c4), and `a3-repoint-on-one-branch-binding-write-on-another.yo` (c2, E0911) with its `-pos` twin (c2b).

**Severity:** S1. `b := idr(&x); match(b, .Some(p) => { x = .None; p.*.s.len() }, …)` passes `yo check`: the arm
overwrites the root while the payload binding `p` still points into it, and the read is a use-after-free (ASan:
SEGV through the freed cell). Present in the released v0.2.76 as well as on develop.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A3).

## Reproducers

`issues/repros/2026-11-11-a-match-arm-binding-over-a-reference-bound-from-a-call-result-does-not-keep-the-root-frozen.yo`
(a local root, `b` bound from a call result):

```yo
idr :: (fn(r : &Option(Rc(X))) -> &Option(Rc(X)))(&r.*);
main :: (fn() -> unit)({
  mut(x) := mk();
  b := idr(&x);
  n := match(
    b,
    .Some(p) => {
      x = .None;
      p.*.s.len()
    },
    .None => usize(0)
  );
  println(`OUT: ${n.to_string()}`);
  ()
});
```

`issues/repros/2026-11-11-a-match-arm-binding-over-a-reference-bound-from-a-call-result-does-not-keep-the-root-frozen-mut-parameter.yo`
(the root is a `&mut` parameter, `b` a direct reborrow of it):

```yo
f :: (fn(a : &mut Option(Rc(X))) -> usize)({
  b := &a.*;
  match(
    b,
    .Some(p) => {
      a.* = .None;
      p.*.s.len()
    },
    .None => usize(0)
  )
});
```

Both: accepted by v0.2.76 and by develop; `--sanitize address` reports `SEGV on unknown address 0x…10`.

## The family

| Shape | Verdict | Correct |
| --- | --- | --- |
| `b := idr(&x); match(b, .Some(p) => { x = .None; p… })` | accepted | E0911 |
| `f(a : &mut …)`: `b := &a.*; match(b, .Some(p) => { a.* = .None; p… })` | accepted | E0911 |
| `f(a : &mut …)`: `b := idr(&a.*); match(b, .Some(p) => { a.* = .None; p… })` | accepted | E0911 |
| `b := &x; match(b, .Some(p) => { x = .None; p… })` (a direct lend of a local) | E0911 naming `b` | E0911 |
| `a := &mut x; b := &a.*; match(b, .Some(p) => { a.* = .None; p… })` (a local `&mut` binding) | E0911 naming `b` | E0911 |
| `f(a : &mut …)`: `match(a, .Some(p) => { a.* = .None; p… })`, `match(&a.*, …)` | E0911 naming `p` | E0911 |
| `f(a : &mut …)`: `b := idr(&a.*); a.* = .None; len_of(b)` (no `match`) | E0911 naming `b` | E0911 |

So the loan of `b` itself is registered and checked in every row; what is lost is the arm binding's share of it. `b`'s
last use is the scrutinee, the arm binding `p` is a place inside `b`'s referent, and in the three accepted rows
nothing extends `b`'s loan (or registers one for `p`) over `p`'s uses.

## Wider family: any local reference binding as the scrutinee

The same audit's patterns-flow (F1) and boundary (B-F2) probes widen the family: the scrutinee need not come
from a call. A `match` on ANY local reference binding, `r := &o; match(r, …)`, gives its arm bindings no share of
`r`'s loan once `r` itself is dead, whether `r` lends a local, lends it `&mut`, or lends a `mut(G)` module-level
place. The direct-lend row of the table above is rejected only because that `match` initializes `n := …`, which
keeps `b`'s loan live over the whole statement: the same program with a statement `match` (the arm prints
`p.*.s`) is accepted and SEGVs under ASan (measured on develop `64f33c710`). The rows below are measured on
develop `64f33c710` and accepted by v0.2.76 too.

| Shape | Verdict | Correct |
| --- | --- | --- |
| `r := &o; match(r, .Some(Box(s)) => { o = .None; use(s.*) })` (m25) | accepted, UAF | E0911 |
| `r := &mut o; match(r, .Some(x) => match(&x.*(0), e => { r.* = .None; use(e.*) }))` (m20) | accepted, UAF | E0911 |
| `r := &mut e; match(r, .A(s) => { r.* = E.B(…); use(s.*) })`: the variant switches under `s` (m04) | accepted, SEGV | E0911 |
| `r := &o; match(r, .Some(x) => { o = .None; use(x.*) })` over `Option(String)` (m03b) | accepted, reads the dropped payload (`OUT: ` empty) | E0911 |
| `r := &mut o; match(&mut r.*, .Some(x) => { r.* = .None; use(x.*) })` (m03e) | accepted, same | E0911 |
| `match(&o, .Some(inner) => match(inner, .Some(bx) => { o = .None; use(bx) }))`: the inner scrutinee is the outer arm's reference binding (o06) | accepted, reads freed memory (aborts on an overflow trap in `ArrayList`) | E0911 |
| `y := &G` (`mut(G)` global); `match(y, .Some(xs) => { e := _first(xs); _reset(); use(e.*) })`, `_reset` writes `G` (boundary g04l) | accepted, UAF: the arm escapes decision 18 rule 3 | E0911 |
| `f(r : &mut Option(String))`: `match(r, .Some(x) => { r.* = .None; … })`, a reference PARAMETER (m03d) | E0911 naming `x` | E0911 |
| `r := &mut o; match(&r.*, .Some(x) => { r.* = .None; … })` (m03f) | E0911 naming `x` | E0911 |
| `match(&o, .Some(x) => { o = .None; … })` and its nested-list twin (m01, m21) | E0911 naming `x` | E0911 |
| `match(&G, .Some(s) => { _reset(); … })` (boundary g04b, ledger) | E0911 "Cannot call `_reset` while `s` is live" | E0911 |

Reproducers (all negative, expect E0911; each a heap-use-after-free under ASan on develop):

- `issues/repros/2026-11-11-a-match-arm-binding-over-a-reference-bound-from-a-call-result-does-not-keep-the-root-frozen-local-reference-binding.yo` (m25)
- `…-mut-local-reference-binding.yo` (m20)
- `…-global.yo` (g04l)

**What the source shows** (`src/evaluator/exprs/match.yo`, the arm loop of the `match` evaluator). The audit's
hypothesis was that the checker treats a `match` on a local reference binding as by-value while codegen binds by
place. That is not what happens: `ref_binds` includes `_scrutinee_is_reference_binding`, so the arm bindings ARE
reference bindings (`is_ref`, `is_borrow_match_binding`). What is missing is a loan for them:

- the `&` loan (`local_borrow_register_match_place` against `imm_place`) is registered only when the scrutinee is
  spelled `match(&place, …)` (`borrowed_match_scrutinee_kind == 1`): that is why m03f and m01 are rejected;
- for a bare scrutinee reached from a local borrow (`lb_scr_source`, `local_borrow_scrutinee_source` in
  `src/evaluator/utils.yo`) the loop only calls `local_borrow_note_pattern_binding`, a record that
  `src/evaluator/exprs/initialization_assignment.yo` reads solely to validate decision 25's re-points, and, in a
  `&mut` match, `local_borrow_note_match_place`, whose contract is "The borrow's own range stays as it is" (it
  serves decision 18 rule 4 across an `await`);
- a reference PARAMETER has no local-borrow record, so `lb_scr_source` is `.None` and the `&mut` match registers
  `x` against `mut_place` (m03d's E0911).

So `r`'s loan ends at its last mention, the scrutinee, and the arm bindings hold no loan of their own: R-ARM's
"arm bindings of a borrowed scrutinee `bind` with the scrutinee's entries" is not implemented for a bare
reference-binding scrutinee. This supersedes the direct-lend explanation in "Root cause" below; the call-result
rows are the same gap. The message of probe cu01 ("`n` is a binding of a by-value `match`") comes from a
different mechanism: a binding below a `Box` in a `&mut` match is classified as a copy
(`issues/fixed/2026-11-11-a-box-sub-pattern-of-a-mut-match-records-no-loan-so-the-arm-can-replace-the-box-under-its-binding.md`).

With the fix, the three reproducers above join the `tests/origins/unsound/` pairs, and the rejected rows stay as
controls in `tests/match_binding_lend.test.yo`.

## Root cause (to confirm in the fix)

`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3 R-ARM: "the arm bindings of a borrowed scrutinee carry the
scrutinee's origin (decision 26)", and §5's `match` row: "arm bindings of a borrowed scrutinee `bind` with the
scrutinee's entries". That `bind` happens when the scrutinee is a direct local borrow (`b := &x`: the decision-18
local-borrow record carries the place, and decision 25's "a pattern binding that a re-point went through is frozen"
path extends it). It does not happen when the scrutinee binding got its origin through `bind` from a call result
(O-1's flow-set table), or when the borrowed place is rooted at a reference PARAMETER (a rigid origin, not a local
place path). The two accepted shapes share that: the scrutinee's entries are not decision-18 local-borrow records.

## Expected

E0911 at the write, naming the arm binding (as the `match(a, …)` row does) or the scrutinee binding.

## Test

With the fix: both reproducers as `tests/origins/unsound/` pairs (positive controls: the write after the `match`),
and rows in `tests/match_binding_lend.test.yo`.

## Partial fix (2026-11-13, branch `fix/c3-value-origins`)

A reference binding matched bare with a `&` loan now gives each by-place arm binding the reference's own loan
entries (`variable_holder_roots`; `origin_of` for any other scrutinee), registered like a `match(&x, …)` binding's,
live to the binding's last use (`src/evaluator/exprs/match.yo`). Rejected now: the call-result row (statement form),
`b := &a.*` over a `&mut` parameter, m25 (`r := &o`), g04l (`y := &G`: rule 3 at the first call while `xs` is live).
G-B rows: `tests/origins/unsound/a3-match-ref-binding-from-call.yo`, `a3-match-reborrow-of-mut-parameter.yo`,
`a3-match-local-reference-binding.yo`, `a3-match-reference-binding-of-global.yo` (E0911), with `-pos` twins for the
first and third.

Still open: a `&mut` REFERENCE BINDING matched bare (m20, m04, m03e; reproducer
`issues/repros/2026-11-11-a-match-arm-binding-over-a-reference-bound-from-a-call-result-does-not-keep-the-root-frozen-mut-local-reference-binding.yo`,
not a G-B row while it fails). Its bindings are recorded
(`local_borrow_note_match_place`) and not registered, because the place model cuts a place at `.*`: `r.* = .None`
(a write through `r`) and `r = &mut n.next` (decision 25's re-point, which must stay legal while `n` lives) are the
same place `r`. Closing it needs a deref step in `LocalBorrowPlace` (a write of `r.*` overlaps a loan of `r.*`, a
write of `r` does not) — a change to the place model shared with the `modes` and `flow` lanes.
