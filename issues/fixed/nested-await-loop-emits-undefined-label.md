# Nested `while`-with-`await`: outer loop loses its back-edge and exit label

**Status: FIXED 2026-08-16** in both compilers. Found 2026-08-15 when it broke
every seed-driven CI job and blocked the v0.2.5 release.

Two distinct defects, both in the async while-loop lowering. The second was
pre-existing and only became observable once the first was fixed (until then the
shape did not compile at all).

## Bug A — the outer loop is lowered as if it were innermost

### Repro

`issues/repros/nested-await-loop-undefined-label.yo`. Shape: a `while` loop
containing an `io.await`, nested inside ANOTHER `while` loop containing an
`io.await`, both inside `match` arms, all inside `io.async`.

```
/tmp/probe.c:13566:14: error: use of undeclared label 'after_while_loop_0'
        goto after_while_loop_0;
             ^
```

The compiler exits 0 and emits C it cannot compile, so the failure surfaces as a
C error with a line number in a 2.2-million-line generated file — a long way
from the two Yo `while` loops that caused it.

### Root cause

`bodyContainsWhileWithAwait` (`src/codegen/async/state-code-gen.ts`) decided
whether a loop encloses another suspending loop, and it only scanned the body's
**top-level** expressions:

```ts
const bodyExprs = /* args of a top-level begin(...) */;
for (const expr of bodyExprs) {
  if (expr is `while` && exprContainsAwait(expr)) return true;
}
return false;                       // never recursed
```

In every ordinary shape the inner loop sits inside a `match` arm or an `if`, and
`if(...)` keeps its macro head in the AST — the branch structure is only
reachable through `$.macroExpansion`. So the detector returned `false`, the
outer loop took the "innermost" path, and it was assigned `awaitPoint.index`
instead of a fresh loop index. It therefore emitted only `while_loop_N_start` /
`while_loop_N_end` and **never** `while_loop_N_continue` / `after_while_loop_N`:
no back-edge, no exit label. Its body ran once, and the transition code's
`goto after_while_loop_N` named a label nobody defined.

The undefined label is the lucky part. Where the name happened to exist, the
same defect is a **silent one-iteration exit**.

Two further holes sat behind it, both reached only once the predicate was fixed:

1. `generateWhileWithAwait` attached the outer loop's info to the inner loop's
   map entry, assuming the inner loop had already been generated. That only
   holds when the outer loop has no await of its own. When the outer loop
   suspends _before_ reaching the nested loop, the nested loop is emitted in the
   **resume** state, so there is no inner entry yet — and the outer stored
   nothing at all.
2. At the branch-continuation forward (`state-machine.ts`), the outer loop's
   chain was carried to the next state only `if (!asyncWhileLoopInfo.has(nextIndex))`.
   Both loops share one await index, the inner loop claims the slot first, and
   the outer's chain was silently dropped — the exact point of loss.

### Fix

- New `exprContainsWhileWithAwait` in `src/expr-traversal.ts`: a deep walk that
  follows `$.macroExpansion`, recurses into `cond`/`match` arms, and stops at
  `io.async` closures and function boundaries (a loop inside one gets its own
  state machine). The old single-use `bodyContainsWhileWithAwait` wrapper is
  gone; `generateWhileWithAwait` calls the new predicate directly.
- `generateWhileWithAwait`: when there is no inner entry to attach to, the outer
  loop stores its **own** entry at the await index with
  `whileLoopOriginIndex = <fresh index>`, so the resume state's active flag,
  loop-back `goto` and exit label all name the outer loop.
- The forward site: when the slot is claimed by a _different_ loop, record this
  loop as that entry's `outerWhileLoop` instead of dropping it, and mark the
  handing-off entry `deferredToOuterWhileLoop` so its own resume state emits
  none of the remaining body, loop-back or exit label. The state that finishes
  the inner loop emits them after `after_while_loop_<inner>` — which is also the
  correct order, since the outer loop's post-await body follows the nested loop.

## Bug B — an awaiting arm's locals are dropped inside the loop

Pre-existing and **independent**: it needs no enclosing loop at all. Confirmed
against the unmodified tree.

```rust
match(seed.get(usize(0)), .None => (), .Some(d) => {
  aio.await(yield(aio), aio);          // arm suspends here
  inner := ArrayList(usize).new();
  inner.push(d); inner.push(d);
  i := usize(0);
  while(runtime(i < inner.len()), {    // ... then runs a suspending loop
    match(inner.get(i), .None => (), .Some(f) => {
      aio.await(yield(aio), aio); count = (count + f);
    });
    i = (i + usize(1));
  });
});
```

Expected `count == 2`, observed `count == 1`.

### Root cause

The arm's code after its own await was chained as the branch's "remaining
code", which the state machine emits at the **top of the loop's resume state** —
i.e. on every iteration. The arm's scope-end drops therefore freed `inner`
during the first iteration, and the loop condition then re-read freed memory
(`inner.len()`) and exited. A silent wrong answer, and a use-after-free.

`generateCondWithAwait` already routes such code to the loop's post-exit slot
(`condBranchPostWhileExprs`, "must only execute once, after the while loop
exits"), but it only finds the loop when it can see the loop's entry — which is
why the shape with an extra `if` layer around the inner loop was correct while
this one was not.

### Fix

In the branch-remaining path (`state-machine.ts`), record which expression
carried the additional await. When it contains a while-with-await, put the
branch's remaining expressions into that loop's `condBranchPostWhileExprs`
instead of chaining them — the same deferral `generateCondWithAwait` performs.

## Files changed

Both compilers, kept as faithful ports of each other:

| TypeScript                            | yo-self                                   |
| ------------------------------------- | ----------------------------------------- |
| `src/expr-traversal.ts`               | `yo-self/expr_traversal.yo`               |
| `src/codegen/async/state-code-gen.ts` | `yo-self/codegen/async/state_code_gen.yo` |
| `src/codegen/async/state-machine.ts`  | `yo-self/codegen/async/state_machine.yo`  |
| `src/codegen/functions/context.ts`    | `yo-self/codegen/functions/context.yo`    |

## Encountered as

`yo-self/version_cache.yo`'s `list_cached_versions` grew an outer loop over two
version roots (P3 item 1's installer/cache unification) around an existing loop
over directory entries. Both loops await. Every seed-driven CI job then failed
at stage 1. It was worked around at the call site in `1238d7d59` by extracting
the inner loop into its own async function (`_scan_versions_root`) — better code
anyway, and that stands; this fixes the compiler underneath it.

## Regression tests

`tests/async_await.test.yo`:

- "an async while whose body awaits then runs a nested awaiting while" — 3 outer
  x 2 inner iterations, asserts 6. Bug A gave a hard C error; a label-only fix
  would give 2.
- "an awaiting match arm keeps its locals alive across a nested awaiting while" —
  asserts 2. Bug B gave 1.

Counts are deliberately asymmetric (3 x 2, not 2 x 2) so a truncated outer loop
cannot coincide with the right answer.

## Verify

```
./yo-cli compile issues/repros/nested-await-loop-undefined-label.yo -o /tmp/probe && /tmp/probe
```

Expected: `probe=6`. Before the fix this failed at the C compiler.

## Note on the earlier diagnosis

The first pass at this issue recorded the cause as "two label-naming conventions
(`while_loop_N_end` vs `after_while_loop_N`), only one emitted" and suggested
renaming one to match. That was wrong, and worth recording as a trap: the two
names are not synonyms. `while_loop_N_end` is emitted **before** the exit `goto`
and is the condition-false exit _inside_ the loop's own state;
`after_while_loop_N` belongs **after** the whole loop. Retargeting the `goto` at
the missing name would have produced a backward jump into the loop — a plausible
green that silently changed control flow. The missing label was a symptom; the
outer loop had lost its entire continuation.
