# The evaluator's inout-in-async check skips `cond` and `match` arms

**Found:** 2026-09-25, recording the Phase 4.4b golden `async-for-inout-is-checked`.
**Severity:** LOW (the program is still rejected, but only by `compile`, not `check`).
**Status:** FIXED on `tss/phase4-4b`.

## Reproducer

In an `io.async` body that awaits:

```rust
if((xs.len() > usize(0)), {
  inout(x) := xs(usize(0));
  x = (x + i32(1));
});
```

`yo check` passed. `yo compile` reported E0904 from codegen
(`_generate_inout_local_binding`). The borrowed `for(xs, inout(x) => ...)` behaved the same
way, because its expansion binds the element inside a `match` arm.

## Root cause

`first_inout_binding_in_async_body` (`src/evaluator/async/await_analysis.yo`, Phase 4.1)
stopped at every `=>` call, to leave nested closures alone. A `cond`/`match` arm is also a
`=>` call, but its body runs in the enclosing frame, so the walk never looked inside any arm.

## Fix

A `cond` or `match` call is walked arm by arm: each `pattern => body` arm's body is judged,
and a closure `=>` elsewhere is still skipped.

## Tests

`tests/cli-cases/async-inout-in-a-cond-arm-is-checked`, `tests/cli-cases/async-for-inout-is-checked`.
