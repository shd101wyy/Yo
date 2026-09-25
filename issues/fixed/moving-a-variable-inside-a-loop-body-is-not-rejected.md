# Moving an outer variable inside a loop body is not rejected: use-after-free in safe code

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** FIXED 2026-09-25 (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 5.1). Was a **memory-safety hole** in safe code: green `check` and `compile`.
**Measured:** yo 0.2.39 seed; re-verified on a develop build `d455b6a67`.

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

Output: `top 1`, `sink 1`, `top 8589934593`, ... with the seed, and `top 4294967297` with the develop
build. The second iteration reads freed memory, and
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

## Resolution (2026-09-25, Phase 5.1)

Moves are tracked per path, and a runtime loop checks its back edges and its ways out:

- **The flow log.** Every assignment and every move of a user-named variable is logged with the
  variable's definite-initialization and move state before and after it (`BranchInitRecord`,
  `src/expr_info.yo`). A `cond`/`match` join and a loop also log their net effect.
- **Per-arm start.** A `cond`/`match` arm starts from the state before the branch
  (`reset_sibling_flow_state`, `src/evaluator/utils.yo`). `Variable` is one shared object per
  binding, so a move in one arm used to be visible to its siblings and to the code after a
  returning arm.
- **Joins.** An arm's end state comes from the log, and only the arms that reach the join count.
  A `return`, `unwind`, `break` or `continue` arm leaves; `break`/`continue` snapshot the loop
  state (`snapshot_loop_flow`).
- **Loops** (`check_loop_flow`, run for a runtime `while` after its body):
  - Every way back to the condition must leave a value that was live at loop entry live. That
    means the body's end, when it can complete, and each `continue`. This is the repro: E0901,
    "`xs` is moved inside the loop, and the next iteration uses it again".
  - Every way out must agree on whether the value is moved: the condition turning false (unless it
    is compile-time `true`) and each `break`. Otherwise E0907 (new: "value moved on some paths
    only"), since Yo decides drops statically.

Found on the way and fixed:
- A move in an arm that returns made every later read of the variable a false "use of moved
  value".
- A move in one arm made a read in its sibling a false "use of moved value". The designed error
  there is the partial move, now E0907.
- A move in a `break` arm poisoned the rest of the loop body.

Tests:
- `tests/cli-cases/loop-carried-move-is-rejected`
- `tests/cli-cases/move-on-one-way-out-of-a-loop-is-e0907`
- `tests/cli-cases/move-in-one-arm-is-e0907`
- `tests/type_soundness.test.yo`: a move in a returning arm; a move on a loop's only way out. Both
  count releases with a `Dispose` counter.
