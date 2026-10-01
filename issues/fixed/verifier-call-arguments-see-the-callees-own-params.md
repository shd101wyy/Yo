# The verifier walked a call's later arguments with the callee's earlier parameters bound

**Severity:** S1 — the verifier proved a false claim. With `same(a, b)`
requiring `a == b`, a caller holding `requires(a != b)` verified the call
`same(b, a)`.

**Status:** FIXED 2026-10-01 (`feat/verifier-for-produced`). Found while
rewriting `tests/spec/fixtures/valid/lemma_member_frame.yo` to call a
free-function `push_at_end(out, xs(i))`. Its loop invariant became
unprovable: the callee's parameter `xs` was already bound to `out` when the
actual `xs(i)` was walked.

## Reproduction

`tests/spec/fixtures/negative/call_arg_swap_false.yo`:

```rust
same :: (fn(a : i32, b : i32, requires(a == b), ensures(true)) -> unit)(());
differ :: (fn(a : i32, b : i32, requires(a != b), ensures(true)) -> unit)({
  same(b, a);
});
```

Measured with a compiler built before the fix: `differ` is `ok`, and the
true twin `valid/call_arg_swap.yo` (`one_more(b, a)` under
`a == b + 1`) is `refuted`.

## Cause

`_callee_call_term` and `_ghost_fn_inline_term` (`src/verifier/vc.yo`)
walked the actuals in one loop. Each iteration walked actual `i`, then bound
the callee's parameter `i` in `ctx.vars` to it. Actual `i + 1` was then
walked with that binding in place, so a caller variable sharing a parameter
name read the callee's binding: in `same(b, a)`, the callee's `a` was bound
to the caller's `b` before the second actual `a` was walked.

## Fix

Both sites walk every actual first, in the caller's scope, then bind the
parameters. `_ghost_fn_app_term` already worked that way.

## Regression test

`tests/internal/verifier_negative.test.yo`, "call actuals are the caller's
values even when they share the callee's parameter names" (both fixtures).
