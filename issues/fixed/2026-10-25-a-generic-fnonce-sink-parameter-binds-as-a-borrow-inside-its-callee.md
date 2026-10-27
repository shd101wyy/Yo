# A generic FnOnce sink parameter binds as a borrow inside its own callee

**Severity:** S2 (a false E0901 that blocks `RefCell.with_mut`'s FnOnce door,
decision 37 / B4-0b; no affected code on develop — no generic callee on the
tree calls its `FnOnce` sink parameter today)

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
`tests/fn_once.test.yo`'s `_run_once`) works, as does a generic
`Impl(Fn(...))` parameter (no consume) and passing a NAMED closure value.
Two shapes fail:

1. a free generic fn whose argument is a closure LITERAL with a plain-data
   (empty or non-RC) capture struct: the argument's resolved capture struct is
   bitwise-copyable, and `bind_parameter`'s `is_owning && !type_is_bitwise_copy`
   carve-out strips the owning flag from the Step-5 beside-binding
   (`check_if_function_parameter_matches_argument`), so
   `consume_called_fnonce_closure` finds no owner beside the non-owning
   specialization shadow;
2. an impl METHOD with the same shape (any capturing lambda): the
   specialization's re-bind loop binds the closure parameter non-owning (by
   design, `calls/helper.yo`'s "The re-bind is NON-owning even for an
   `own(p)` parameter"), and no owning beside-binding is visible in the
   shadow's frame — the exact shape `RefCell.with_mut`'s conversion needs.

Probe P-B of plans/handover/VBD_LOOKAHEAD_2026-10-23.md (§8) tested only a
CONCRETE local helper, which is why the handover's "Seed: none" claim missed
this.

## The fix

**Status:** fixed 2026-10-27 (branch `fix/b4-0b-fnonce-compiler-half`, cherry-picked
from `vbd/b4-0b-full-state` @2aa8bc1fe), together with the sibling S1 it would
otherwise have exposed at runtime
(`issues/fixed/2026-10-25-an-fnonce-closure-literal-at-a-method-call-is-released-twice.md`).

- `src/env.yo` `bind_parameter`: a closure or function value is exempt from
  the bitwise carve-out — it always moves into a by-value parameter and an
  `FnOnce` call consumes it, so its parameter binding stays owning even when
  the capture struct is plain data (shape 1).
- `src/evaluator/calls/helper.yo` (the specialization re-bind loop): a
  closure parameter whose declared type's fn-trait base is `FnOnce` and for
  which no owning binding is visible gets an OWNING twin bound beside the
  non-owning shadow, which the call (or a relay's capture move) consumes, so
  the parameters-frame scope-end pass skips its release (shape 2).
  `_owning_param_binding_for_capture_move` (`src/evaluator/utils.yo`) is
  exported for that lookup.

The `RefCell.with_mut` flip to `sink(body) : Impl(FnOnce(...))` is NOT part of
this fix: it is Generation B (the v0.2.70 seed rejects every caller of such a
`with_mut`), so it waits for a seed that carries this fix.

## The test

`tests/fn_once.test.yo`, "a generic FnOnce sink parameter is callable inside
its own callee": a free generic fn and an impl method, each calling its
`FnOnce` sink parameter once. Both are a false E0901 at check before the fix
and pass after it.
