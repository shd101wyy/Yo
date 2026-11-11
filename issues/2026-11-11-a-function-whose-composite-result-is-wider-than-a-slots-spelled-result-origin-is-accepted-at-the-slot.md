# A function whose composite result is wider than a slot's spelled result origin is accepted at the slot

**Severity:** S1. A named function or a closure literal whose result `Option(&T)` may point into ANY of its
parameters is accepted at a function-pointer or `Impl(Fn(...))` slot that spells the result over ONE parameter. The
function that owns the slot is checked against the slot's type, its caller freezes only that one argument, and the
value returns a reference into another: heap-use-after-free under ASan. Pre-existing: v0.2.76 accepts both programs.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A48), as probe (b) of VERDICTS-57. Confirmed on develop
`64f33c710`. The impl-against-trait twin is
`issues/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait.md`.

## Reproducers

`issues/repros/2026-11-11-a-function-whose-composite-result-is-wider-than-a-slots-spelled-result-origin-is-accepted-at-the-slot.yo`
(negative, expects E0923 at the argument `pick_other`):

```yo
pick_other :: (fn(a : &Rc(X), b : &Rc(X)) -> Option(&Rc(X)))(.Some(b));
apply :: (fn(f : (fn(a : &Rc(X), b : &Rc(X)) -> Option(&(Rc(X), a))), x : &Rc(X), y : &Rc(X)) -> Option(&(Rc(X), x)))(f(x, y));
main :: (fn() -> unit)({
  a := mkr();
  mut(o) := Option(&Rc(X)).None;
  {
    b := mkr();
    o = apply(pick_other, &a, &b);
  };
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted.
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-closure-literal.yo` (negative, expects E0923): the argument is the literal
  `(p : &Rc(X), q : &Rc(X)) => Option(&Rc(X)).Some(q)` at `f : &Impl(Fn(a : &Rc(X), b : &Rc(X)) -> Option(&(Rc(X), a)))`.
  Same use-after-free.
- `…-pos.yo` (positive control): `pick_first`, which spells `-> Option(&(Rc(X), a))` and returns `.Some(a)`, at the
  same slot. Accepted, prints `OUT: 72`.

## The family (develop `64f33c710`; v0.2.76 gives the same verdicts)

| Shape | Verdict | Correct |
| --- | --- | --- |
| a named fn with an elided `Option(&T)` result at a function-pointer slot spelling the result over its first parameter | accepted, UAF | E0923 at the argument |
| a closure literal returning its second parameter at an `Impl(Fn(...))` slot spelling the first | accepted, UAF | E0923 at the literal |
| the named fn at an `Impl(Fn(...))` slot | check accepts; the C does not compile (`void **` passed; the named-function-at-an-`Fn`-slot emission gap) | E0923 |
| `dyn(pick_other)` bound to a `Dyn(Fn(...) -> Option(&(Rc(X), a)))`, called with a block-local second argument | E0911 at the store (the call's result is taken as the union) | E0923 at the `dyn(...)`; the store is then legal |
| the function returns its first parameter and spells it | accepted, runs clean | accepted |

The bare `-> &T` form of the first row was not measured: its `apply` body `f(x, y)` is rejected today for an
unrelated reason (the R3 family: a reference result of a call through a function-pointer parameter is copied).

## Root cause

The origin comparison O7 asks for exists only for impl members: `_impl_result_origin_wider`
(`src/evaluator/values/impl.yo`) compares an impl method's result origins with its trait's, and has no other
caller. Where a function value or a closure literal is matched against a parameter of function type, the two
types are compared with their origins erased, so a result that names more parameters than the slot allows
type-checks. (Hypothesis for the exact site: the argument compatibility check in
`src/evaluator/calls/function.yo`; the missing comparison is confirmed, the site is not.) The callee, `apply`, is
then checked correctly against the slot's type, and R-CALL at `apply`'s caller substitutes only `x`: nothing
freezes or bounds `b`.

## Expected

`plans/backlog/REFERENCES_AND_ORIGINS.md` O2: a closure literal at an `Fn` slot is checked with the slot's
per-call origins rigid; O7: "a lent `Impl(Fn(...))` slot's own origin parameters must subsume the literal's", and
the same holds for a named function used as a value (made explicit 2026-11-11). The value's result origins, read
under the slot's parameter names, must be a subset of the slot's: `{a, b} ⊆ {a}` fails, E0923 naming both sets. The
check covers every origin in the result type, as the impl check must (the linked issue), and a slot's parameter
origins invariantly (O3 step 3).

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`fn-value-wider-result-at-slot` (E0923) and `closure-literal-wider-result-at-slot` (E0923) beside
`closure-caps-exceed-slot`; a case in `tests/closure_capture_list.test.yo`.
