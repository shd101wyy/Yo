# A tuple literal that lends a place and moves or relends it gets no decision-28 overlap check

**Severity:** S1. `match((&x, x), (a, b) => { eat(b); use(a) })` passes `yo check`: one tuple both lends `x`
and moves it, the arm drops the moved value through `b` and reads it through `a` (ASan: heap-use-after-free).
`(&mut x, &mut x)` gives two live `&mut` references to one place. The same arguments in a call are E0910.
Pre-existing: v0.2.76 accepts every reproducer too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A17). Confirmed on develop `64f33c710`.
Re-check after P2 (`&x` as an expression, lane `vbd/p2-ref-expr`) lands: P2 makes tuple components first-class
and may subsume this.

## Reproducers

`issues/repros/2026-11-11-a-tuple-literal-that-lends-a-place-and-moves-or-relends-it-gets-no-decision-28-overlap-check.yo`
(negative, expects E0910):

```yo
eat :: (fn(b : Box(String)) -> unit)(());
main :: (fn() -> unit)({
  x := Box.new(L());
  match(
    (&x, x),
    (a, b) => {
      eat(b);
      println(`OUT: ${a.*.*}`);
    }
  );
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-mut.yo` (negative, E0910): `match((&mut x, &mut x), (a, b) => { a.* = String.from("a"); println(b.*) })`
  prints `OUT: a`: a write through one `&mut` is seen through the other.
- `…-pos.yo` (positive control): `match((&x, &x), …)`, two `&` lends of one place; accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `match((&x, x), (a, b) => { eat(b); use(a) })` | accepted, UAF | E0910 |
| `match((&mut x, &mut x), …)` | accepted, two live `&mut` | E0910 |
| `match((&x, &mut x), (b, a) => { a.* = …; use(b) })` (ledger t11) | accepted | E0910 |
| `match((&mut x, x), …)` (ledger t12) | accepted | E0910 |
| `t := (&x, x);` with no `match` (ledger t16) | accepted | E0910 |
| `match((&x, &x), …)` | accepted | accept |
| the call `both(&x, x)`, `both : (a : &Box(String), b : Box(String))` | E0910 "This argument moves `x`, which an earlier argument of the same call lends" | E0910 |
| the call `two(&mut x, &mut x)` | E0910 | E0910 |

## Root cause

Confirmed by reading the source. Decision 28's checks run for calls only: `_call_lends`,
`_check_call_lent_place_moves` and `_check_call_value_root_overlap` in `src/evaluator/calls/function.yo` are
invoked from the call evaluator and walk the call's argument list. A tuple literal is evaluated by
`evaluate_tuple_value` / `evaluate_tuple_element_value` (`src/evaluator/values/tuple.yo`), which accepts a lend
element (`&place`, `&mut place`, "decision 43 step 3, T9"), evaluates each element on its own and never
compares one element's lent place with another element's lend or move. No later check catches it: the tuple is
a temporary until the `match` destructures it, so the move of `x` happens while no binding holds the lend.

## Expected

E0910 at the second element, as for a call's arguments. `plans/VALUES_BY_DEFAULT.md` decision 28 ("Value roots.
A `&mut` argument, or a by-value argument of a non-implicitly-copyable type (a move), that overlaps any other
argument is a compile error. Two `&` arguments may overlap."), applied to the components of a tuple literal (and
of any other composite literal that can hold a lend), which `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` R-COMP
treats as one value whose origin is "the union of the components' origins".

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`tuple-lend-and-move-one-place` (E0910) and `tuple-two-mut-lends-one-place` (E0910) in
`tests/origins/corpus.tsv`; a case in `tests/match_tuples.test.yo`.
