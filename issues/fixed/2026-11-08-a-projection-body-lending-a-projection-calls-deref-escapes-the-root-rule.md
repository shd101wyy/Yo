# A projection body that lends a projection call's deref escapes the root rule

**Severity:** S1. An unsound program was accepted: a function returned a `&mut` into its own local.

Filed and fixed 2026-11-08 by the G2 lane, on `fix/impl-origin-in-method-result`. It is a regression from #1834 (`issues/fixed/2026-11-05-dereferencing-a-projection-call-result-is-an-internal-error.md`), found while writing that branch's negative tests.

## Reproducer

```yo
first_mut :: (fn(p : &mut i32) -> &mut i32)(&mut p.*);
leak :: (fn() -> &mut i32)({
  mut(x) := i32(1);
  &mut first_mut(&mut x).*
});
main :: (fn() -> unit)(());
export(main);
```

Results by compiler:

- develop `beefabda4` (with #1834) accepts it. The result points into `leak`'s frame.
- The v0.2.76 seed (without #1834) rejected it, but only as a side effect: it reported `&: failed to evaluate the argument expression for reference`.

## Root cause

#1834 records `f(x).*` as rewritten to the call (`note_rewritten_node_as`), so the node's own id names a different node. `_projection_root_error` (`src/evaluator/builtins/ptr_fns.yo`) took apart the REWRITTEN node, the call `first_mut(&mut x)`. But its `cond` still tested the ORIGINAL node, which is a `.` call. So it read the call's argument list as a field access's `[base, field]`. There was no field at index 1, so the arm returned "no error".

## Fix

`_projection_root_error` and `_by_value_borrow_param_root` now recurse on the rewritten node when it is another node of its own id. The call is then judged by `_projection_call_root_error`: its roots must be the projection's own borrow parameters, so `x` here is E0912.

## Test

`tests/origins/reference_read_rule.test.yo`, the `comptime_expect_error` `rr_deref_call_local_escapes`: returning `&mut rr_first_mut(&mut q).*` with `q` a local is E0912.
