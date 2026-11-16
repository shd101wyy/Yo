# An argument lending a projection call's place holds no loan of the call's roots

**Severity:** S2 — a borrow-check soundness hole: `f(&mut s, &s.view().*)` and `f(&mut s, &view(&s).*)` are accepted, so
the callee receives `&mut s` beside a reference into `s` and can invalidate it (a `push` that reallocates under a
live slice).

**Status:** fixed 2026-11-16 on `vbd/d49-deref-owner` (VERDICTS-63 Generation A).

Found 2026-11-16 by the deref-owner lane while checking VERDICTS-63 decision 13's rows against an owner's `&b.*`,
which lowers to `&b.deref().*`. Decision 13's p2d row passes the projection call bare (`push_and_sum(&mut b, b.view())`)
and is E0910 on develop; the same call lending the place with `&f(x).*` was accepted on develop `223b188f4`, with any
projection call, so the hole is not the owner's.

## Reproducer

```yo
S :: struct(x : i32);
impl(S, xr : (fn(self : &Self) -> &i32)(&self.x));
_xr :: (fn(s : &S) -> &i32)(&s.x);
_bump :: (fn(s : &mut S, v : &i32) -> i32)({
  s.x = (s.x + i32(1));
  v.*
});
main :: (fn() -> unit)({
  mut(s) := S(x : i32(1));
  _a := _bump(&mut s, &s.xr().*); // accepted; `_bump(&mut s, s.xr())` is E0910
  _b := _bump(&mut s, &_xr(&s).*); // accepted
});
export(main);
```

## Root cause

O3 step 2 (`_check_call_value_loans`, `src/evaluator/calls/function.yo`) collects the loans each argument VALUE holds
(`_call_value_loans`). For a lend `&p` it reads the place `p`; for `&f(x).*` that place is the `.*` node, which the
evaluator records rewritten to the projection call (`note_projection_call_deref`). The collector read the `.*` node as
written: its type is the referent, which carries no origin, so the call's roots (`s`) never became loans.

## Fix

`_call_value_loans` reads a lent place through `ast_rewritten_node` when the rewritten node is a projection call, so
`&f(x).*` holds the same loans as the bare `f(x)`.

## Test

`tests/deref_owner.test.yo`: "an argument lending a projection call's place holds the call's loans" (both spellings
above, and a copy out of the place that lends nothing) and the `_push_and_sum(&mut b, &b.*)` row of "a live view
freezes the owner (decision 13)". G-B: `tests/origins/unsound/a-projection-place-argument-beside-mut.yo` (expects
E0910) with its `-pos` control (a clone out of the place, run under ASan).
