# A bare projection call as a projection body is a misleading E0601

**Severity:** S3. The correct spelling compiles; only the diagnostic for the missing marker is wrong.

Filed 2026-10-18 while deciding `issues/retired/borrowed-for-over-user-defined-collections.md`. Found with a develop-built compiler (`29ceb209d` plus #1440's branch). Fixed the same day.

## Symptom

The repro is `issues/repros/2026-10-18-bare-projection-call-tail.yo`: a value collection whose `walk_elem` (`-> &mut i32`) forwards the inner list's projection without the call-site marker.

```yo ignore
walk_elem : (fn(self : &mut Self, cur : &usize) -> &mut i32)(self.items.walk_elem(cur)),
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "*(i32)"
```

With the marker, `(&mut self.items.walk_elem(cur))` (or the index form `&mut self.items(cur)`), the same program compiles and runs correctly.

## Cause (traced)

The tail of a projection body is evaluated with the function's expected `*(T)` — the address the `&`/`&mut` marker would produce (`rewrite_projection_tails`, decision 24). The bare tail is a DIRECT projection call, whose result is a PLACE of type `T`. Step 10 of the call specialization (`src/evaluator/calls/helper.yo`, the return-type-vs-expected `synthesize_types`) unified the callee's re-evaluated return `T` against that expected `*(T)` and hard-threw E0601 — the internal pointer spelling `*(i32)`, naming no fix. The index form (`self.items(i)`) never reaches that step (index-trait dispatch), so it reported the decision-24 message all along.

## Fix

- `src/evaluator/calls/helper.yo` (Step 10): a direct projection call whose expected type is a pointer skips the return-vs-expected synthesis — gated on a CONCRETE callee return (a `SomeT` return can still bind against the expected), so only the previously-throwing shape changes. The call keeps its place type and reaches the function's result-position check.
- `src/evaluator/calls/function_type.yo` (the result-position check): the decision-24 message now names the forwarding when the body's tail is itself a direct projection call (`projection_call_mode_of`) — "The body forwards another projection: a `&mut T` result lends it at the call site — write `&mut self.items.walk_elem(cur)`." — E0914's style for arguments, with no internal pointer type shown.

## Test

`tests/cli-cases/bare-projection-call-tail-names-the-marker` pins the message: `yo check main.yo` on a `walk_elem` forwarding `self.items.walk_elem(cur)` reports the decision-24 error with the forwarding sentence and rc=1. Before the fix the same input reported `error[E0601]: Cannot unify incompatible types: "i32" and "*(i32)"`.
