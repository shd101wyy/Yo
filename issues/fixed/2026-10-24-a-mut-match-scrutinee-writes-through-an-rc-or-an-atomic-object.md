# A `&mut` match scrutinee writes through an `Rc` or an atomic object

**Severity:** S2 — safe code wrote into a shared `Rc` payload (decision 46's
E0919 missed it) and into an `Arc` or `atomic(ref(…))` object from any thread
(D3 missed it); a `&mut` local borrow binding of a place in an atomic object
missed D3 the same way.

**Status:** fixed 2026-10-24 on `feat/v5-seed-predicates`. Found by the
adversarial review of V5's seed predicates (`plans/VALUES_BY_DEFAULT.md`
§3.5); it predates that branch: the installed seed v0.2.69 accepts every
program below.

## Evidence

Each of these compiled in a safe file and printed the written value:

```yo ignore
h := rc(_P(x : i32(1), items : ArrayList(i32).new()));
match(&mut h.*, _P(x : mut(xx), items : _) => { xx = i32(4); });   // x=4: E0919 missed

a := arc(_P(x : i32(1), items : ArrayList(i32).new()));
match(&mut a.*, _P(x : mut(xx), items : _) => { xx = i32(4); });   // x=4: D3 missed

S :: atomic(ref(struct(x : i32)));
s := S(x : i32(1));
match(&mut s.x, xx => { xx = i32(4); });                           // x=4: D3 missed
m := &mut s.x;                                                      // the binding form
m = i32(4);                                                         // x=4: D3 missed
```

The same writes spelled as an assignment (`h.*.x = …`, `a.*.x = …`), a `&mut`
argument or a `self : &mut Self` receiver were rejected, and so was
`m := &mut h.x` through an `Rc` (E0919).

## Root cause

A `&mut` match scrutinee (`MATCH_MODE_MUT`, `evaluate_match` in
`src/evaluator/exprs/match.yo`) lends its place to the arms' bindings, which
may write it, but the path checked only decision 47's `mut` binding and the
local-borrow exclusivity: it never called `reject_write_through_rc` (E0919)
nor any D3 check. The `&mut` borrow binding paths of
`src/evaluator/exprs/initialization_assignment.yo` called
`reject_write_through_rc` but no D3 check, so a place in a user
`atomic(ref(…))` object (no `Rc` handle in it) was lent writable.

## Fix

`throw_if_mut_lend_through_atomic_object` (`src/evaluator/exprs/assignment.yo`)
is D3 for a local `&mut` lend: a place rooted in an atomic object, or crossing
one past its root (`place_cell_hops`), is rejected in safe code. Lending the
binding itself (`&mut a`) lends the handle, not the object, and stays legal;
a write through that borrow is judged where it happens. The `&mut` match
scrutinee calls it and `reject_write_through_rc`; both `&mut` borrow binding
paths call it before their E0919 check.

## Tests

- `tests/rc.test.yo`: "a `&mut` match scrutinee in an Rc's payload is E0919".
- `tests/parallelism_soundness.test.yo`: three D3 blocks (a borrow binding and
  a match scrutinee in a user atomic object, a match scrutinee through an
  `Arc`) and a canary for a plain place and the atomic binding itself.
- `tests/cell_handles.test.yo`: the same through V5's cell handles.
