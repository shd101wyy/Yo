# An `inout` argument passed to an `own` parameter moved the referenced handle without a dup (UAF)

**Status: FIXED (2026-09-07, PR #476, found in its second soundness review).**
Pre-existing for `inout` PARAMETERS (since `inout` params exist); the new
`inout(name) := place` bindings reached the same path.

## Symptom

```rust
sink :: (fn(own(v) : String) -> usize)(v.len());
via_param :: (fn(inout(p) : String) -> usize)(sink(p));
s := String.from("abc");
via_param(s);
assert(s == "abc");   // FAILED: s was released by sink's own-param drop
```

Same with a local binding: `inout(r) := s; sink(r);`.

## Root cause

Two halves, one per stage:

- `src/evaluator/calls/helper.yo`, the own-parameter branch: a non-owning
  argument variable gets `set_expr_as_needs_to_call_dup` (copy) AND
  `set_expr_as_consumed`. For an `is_ref` variable the consumption is wrong
  (the binding names a slot it does not own; nothing moves), but the dup
  request was right.
- `src/codegen/exprs/other_fn_call.yo`, `_materialize_arg`: the deref read
  `(*name)` of an `is_ref` variable was classed as "transfers no ownership"
  and returned WITHOUT emitting the deferred dup. The callee received the
  slot's only count and released it at its scope end.

## Fix

- helper.yo: `is_ref` arguments only request the dup; they are never marked
  consumed (the parameter/binding stays usable after the call).
- `_materialize_arg`: the deref-read case goes through
  `emit_deferred_dup_or_code` with the `(*name)` spelling (the emitter already
  knows not to redeclare it), so the copy's `+1` is emitted before the call.

## Tests

- `tests/ref_params.test.yo` — "inout parameter passed to an own parameter
  copies, the referenced slot survives".
- `tests/ref_local_binding.test.yo` — "passing the binding itself to an own
  parameter copies; the root survives and the binding stays usable".
