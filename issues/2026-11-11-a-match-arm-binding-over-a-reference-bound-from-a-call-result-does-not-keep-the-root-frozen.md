# A `match` arm binding over a reference bound from a call result does not keep the root frozen

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
