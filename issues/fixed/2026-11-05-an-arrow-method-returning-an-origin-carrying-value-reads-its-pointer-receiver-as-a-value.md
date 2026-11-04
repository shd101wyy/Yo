# An arrow method returning an origin-carrying value reads its pointer receiver as a value

**Severity:** S2: a regression from #1771 (N2g-0) that produces C which does
not compile. An arrow-form method or closure whose result carries an origin,
such as `peek : (self -> .Some(&self.n))` for `peek : fn(self : &Self) ->
Option(&i32)`, got a pointer prototype for its `&T` parameter. Its body read
that pointer as a struct (`self.n` instead of `(*self).n`).

> Found 2026-11-05, an hour after #1771 merged, while probing N2b-r's
> `derive(Clone)` over a reference field (a `(self -> Self(...))` clone of an
> origin-parameterized holder). Nothing on develop hits it: the only tests
> with origin-carrying results (`borrow_spelling`, `ref_return_ban`,
> `ref_payload_binding`) spell their methods with `fn`, and neither std nor
> `src/` has such a result yet.

## Reproducer

```yo
Cell :: struct(n : i32);
Peek :: trait(peek : (fn(self : &Self) -> Option(&i32)));
impl(Cell, Peek(peek : (self -> .Some(&self.n))));
main :: (fn() -> unit)({
  c := Cell(n : i32(8));
  _ := match(c.peek(), .Some(r) => r.*, .None => i32(0));
  ()
});
export(main);
```

clang reports `member reference type 'Cell *' is a pointer` in `peek`'s body.

## Root cause

#1771 widened `fn_param_is_ptr_borrow` from "the result is a borrow" to "the
result is a borrow or carries an origin". The prototypes, the call sites,
the named-function binders and the `Dyn` vtables read the predicate directly.
The arrow and closure binder (`src/evaluator/values/anonymous_function.yo`)
consulted it only inside an `fn_result_is_ref` gate, so the body bound the
parameter by value.

A second, smaller defect was in the same code path. An enum variant's
reference payload was addressed after `sequence_operand`. When a later
operand read the payload's root, the place was first hoisted into a
temporary, and the payload then pointed at that temporary.

## Fix

- The binder's gate is now `fn_result_is_ref(ft) || fn_param_is_ptr_borrow(ft, i)`.
- The variant payload is addressed before sequencing, and is passed as a
  pointer operand, so it is never hoisted.

Tests: in `tests/ref_payload_binding.test.yo`, "an arrow method's receiver of
an origin-carrying result" (direct and through `Dyn`) and "a variant with a
reference and a later operand".
