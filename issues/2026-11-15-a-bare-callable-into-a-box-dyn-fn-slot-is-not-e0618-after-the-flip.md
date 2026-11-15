# A bare callable flowing into a `Box(Dyn(Fn(...)))` slot is not E0618 after the flip

**Severity:** S1 (a program decision 44 rejects is accepted: a named closure passed bare where a `Box(Dyn(Fn))` is expected type-checks)

## What happened

Under decision 49's flip, a `Dyn` is unsized, so the slot that takes an erased callable is its owning
handle, `Box(Dyn(Fn(...)))`. E0618's predicate, `_dyn_carries_fn_trait`, accepted only a bare `DynT`.
So these went unreported:

- a named closure, a named `fn` or an `Impl(Fn)` parameter flowing bare into a `Box(Dyn(Fn))` binding,
  field, argument or result;
- a closure literal in such a slot (`anonymous_function.yo` matched only an expected `DynT`).

`yo explain E0618`'s bad example (`run(f)` with `run : fn(d : Box(Dyn(Fn() -> i32)))`) loaded clean.
`tests/closure.test.yo`'s decision 44 rows expect E0618 at exactly these slots. Found by checking the
registry examples with the flip binary, after `tests/internal/diagnostics_registry_examples` failed.

## Fix

`is_dyn_fn_slot` (`src/types/utils.yo`, the renamed predicate) also reads an owning handle over a
`Dyn` listing an `Fn` trait: `Box`, and the interim `Rc`/`Arc` cell views. The closure-literal check
in `anonymous_function.yo` uses the same predicate.

Test: `tests/closure.test.yo`'s decision 44 rows, together with
`tests/internal/diagnostics_registry_examples.test.yo` (E0618's bad example).
