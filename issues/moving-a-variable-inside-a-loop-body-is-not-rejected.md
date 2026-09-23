# Moving an outer variable inside a loop body is not rejected: use-after-free in safe code

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** OPEN. **Memory-safety hole** in safe code: green `check` and `compile`.
**Measured:** yo 0.2.39 seed.

## Repro

```rust
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
sink :: (fn(own(xs) : ArrayList(i32)) -> unit)({
  println(`sink ${xs.len()}`);
});
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  (i : i32) = 0;
  while(runtime(i < 3), {
    println(`top ${xs.len()}`);
    sink(xs);
    i = (i + 1);
  });
});
export(main);
```

Output: `top 1`, `sink 1`, `top 8589934593`, ... The second iteration reads freed memory, and
each iteration frees `xs` again. The emitted C passes `xs` to `sink` on every iteration with no
dup.

Straight-line use after `own` (E0901) and use after a move inside an `if` are correctly rejected.

## Mechanism (READ)

A move is the per-variable flag `Variable.consumed_at_token` (`src/evaluator/builtins/consume.yo`
~99), checked on later reads (`src/evaluator/utils.yo` ~404-438). `src/evaluator/exprs/while.yo`
has no handling of consumed variables, so a move in the body is never checked against the next
iteration's reads. The same-site "re-evaluation exemption" at `utils.yo` ~407-420 would also hide
a naive re-check.

## Fix direction

At the end of a loop body, any outer-scope variable that is consumed and not re-assigned before
the back edge is an error: "`xs` moved in a previous iteration of the loop", with the move site.
Apply it to `while`, `for` and any loop-shaped desugaring.
