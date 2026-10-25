# A generic FnOnce sink parameter binds as a borrow inside its own callee

**Severity:** S2 (blocks `RefCell.with_mut`'s FnOnce door, decision 37 / B4-0b; no
known affected code on develop, because no generic callee calls its `FnOnce`
sink parameter today)

## The bug

A `sink(f) : Impl(FnOnce(...))` parameter of a GENERIC function (or impl
method) binds NON-OWNING inside the callee's own specialized body, so the
callee's single call of it is a false E0901:

```yo ignore
take :: (fn(generic(R : Type), sink(body) : Impl(FnOnce() -> R)) -> R)(
  body()
);
main :: (fn() -> unit)({
  _ := take(() => i32(7)); // E0901: cannot call `body` ... it is a borrowed parameter
});
```

The same signature without the generic (`fn(sink(f) : Impl(FnOnce() -> i32))`,
`tests/fn_once.test.yo`'s `_run_once`) works, so does a generic `Impl(Fn(...))`
parameter (no consume), and so does passing a NAMED closure value. Two shapes
fail:

1. a free generic fn whose argument is a closure LITERAL with a plain-data
   (empty or non-RC) capture struct: the argument's resolved capture struct is
   bitwise-copyable, and `bind_parameter`'s `is_owning && !type_is_bitwise_copy`
   carve-out strips the owning flag from the Step-5 beside-binding
   (`check_if_function_parameter_matches_argument`), so
   `consume_called_fnonce_closure` finds no owner beside the non-owning
   specialization shadow;
2. an impl METHOD with the same shape whose lambda body moves an implicit
   capture (the exact `RefCell.with_mut` conversion shape,
   `cell.with_mut(m => m.insert(s, s))`): the specialization's re-bind loop
   binds the closure parameter non-owning (by design, `calls/helper.yo`'s
   "The re-bind is NON-owning even for an `own(p)` parameter"), and the owning
   beside-binding is not in the shadow's frame on the impl-method path.

Found by B4-0b (plans/handover/VBD_LOOKAHEAD_2026-10-23.md §4.1): converting
`std/sync/refcell.yo`'s `with_mut` to `sink(body) : Impl(FnOnce(...))` made
every `g.with_mut(m => ...)` call in src fail check with this E0901.

## The fix

- `src/env.yo` `bind_parameter`: a closure or function value is exempt from the
  bitwise carve-out — it always moves into a by-value parameter and an
  `FnOnce` call consumes it, so its parameter binding must stay owning even
  when the capture struct is plain data (shape 1).
- `src/evaluator/calls/helper.yo` (the specialization re-bind loop): a closure
  parameter whose declared type's fn-trait base is `FnOnce` re-binds OWNING
  (shape 2). The call consumes the binding, so the parameters-frame scope-end
  pass skips its release; one the body never calls releases exactly as a
  concrete sink parameter already binds at definition time.

## The test

`tests/fn_once.test.yo`, "a generic FnOnce sink parameter is callable inside
its own callee": a free generic fn and an impl method, each calling its
`FnOnce` sink parameter once, one argument a plain-data literal, one a
capture-moving lambda. Both fail check before the fix and run after it.
