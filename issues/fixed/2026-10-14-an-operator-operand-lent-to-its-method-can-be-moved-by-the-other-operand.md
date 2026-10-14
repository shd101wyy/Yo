# An operator operand lent to its method can be moved by the other operand

**Severity:** S1 — `a == make(eat(a))` was accepted, and `(==)` read `a`
after `eat` had moved it out and dropped it: a use after free when `a` owns
memory.

Found 2026-10-14 by the v0.2.62 adversarial review (dimension "lent-move").
It predates v0.2.62: v0.2.61 behaves the same. The E0910 rule of
`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-a-call.md`
did not reach operator calls.

## Symptom

```yo ignore
Res :: struct(s : String);
impl(Res, Dispose(dispose : (fn(self : &Self) -> unit)(println(`dropped ${self.s}`))));
impl(Res, Eq(Res)((==) : ((lhs, rhs) -> {
  println(`eq reads ${lhs.s}`);
  lhs.s == rhs.s
})));
eat :: (fn(r : Res) -> i32)(i32(r.s.len()));
make :: (fn(k : i32) -> Res)(Res(s : k.to_string()));
main :: (fn() -> unit)({
  a := Res(s : String.from("hello-42-world-long-enough-to-heap"));
  b := (a == make(eat(a)));   // accepted
  println(&b);
});
```

`yo check` accepted it. At run time it printed `dropped hello-…` and then
`eq reads ` with an empty string, and stopped with `EXC_BAD_ACCESS` in the
allocator (heap corruption). `a != e` behaved the same. The same call spelled
`Res.(==)(&a, &make(eat(a)))` was rejected with E0910, so only the spelling
decided whether the check ran.

## Root cause

`Eq`'s `(==)`/`(!=)` take `lhs : &Self, rhs : &Rhs`, and `Ord`'s
`(<)`/`(<=)`/`(>)`/`(>=)` do too (`std/prelude.yo`), as do `(..)`/`(..=)`.
An infix operator lends those operands without a marker: codegen passes
`&a`. `_check_call_lent_place_moves` found lent places syntactically, as a
written `&x`/`&mut x` argument (`_lent_argument_place`) or a method receiver
(`_call_receiver_place`). The infix call `a == e` has neither, so the borrow
of `a` was never checked against the later operand.

## Fix

`_operator_operand_is_ref` (`src/evaluator/calls/function.yo`) reads the
resolved operator method's `param_is_ref`, which the operator path stamps on
the operator atom for a call evaluated at run time (a call folded at compile
time lends nothing at run time). `_check_call_lent_place_moves` treats each
operand that is a plain place and that the method borrows as lent, exactly as
it treats a written `&a`: a later operand may not move it, overwrite it or
lend it `&mut` (E0910). No operator list is hard-coded; any operator whose
method borrows an operand is covered. `_lent_roots_moved_before` takes every
place operand of an infix call, since which ones are lent is known only after
the method resolves; that list only exempts roots already moved before the
call.

Regression test: `tests/parameter_modes.test.yo`, "an operator operand its
method borrows cannot be moved by the other operand" (`==`, `!=`, `<` with a
move, `>=` with an overwrite; a move of another binding, `a == a` and a plain
comparison stay accepted).
