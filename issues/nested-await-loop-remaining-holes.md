# Nested await-loops: two holes remaining after the back-edge fix

**Status: OPEN.** Found 2026-08-16 while verifying
`issues/fixed/nested-await-loop-emits-undefined-label.md`. Both are in the
shapes that fix newly makes compilable — neither is a regression of code that
worked before, because **both shapes failed to compile at all** on the pre-fix
compiler.

Read the fixed issue first; it explains the lowering and the vocabulary
(`while_loop_N_continue`, `after_while_loop_N`, `outerWhileLoop`,
`condBranchPostWhileExprs`).

## Hole 1 — outer loop with NO await of its own: the inner loop truncates

Repro: an outer `while` whose body has no `io.await` outside the nested loop,
with the inner await-loop inside a `match` arm.

```rust
while(runtime(r < outer.len()), {
  match(outer.get(r), .None => (), .Some(d) => {
    inner := ArrayList(usize).new();
    inner.push(d); inner.push(d);
    i := usize(0);
    while(runtime(i < inner.len()), {
      match(inner.get(i), .None => (), .Some(f) => {
        aio.await(yield(aio), aio); count = (count + f);
      });
      i = (i + usize(1));
    });
  });
  r = (r + usize(1));
});
```

With `outer = [1, 10, 100]` and two inner entries per outer element, `count`
should be 222.

| compiler                 | result                                              |
| ------------------------ | --------------------------------------------------- |
| before the back-edge fix | `error: redefinition of label 'while_loop_0_start'` |
| after                    | compiles, `count == 111`                            |

111 is 1+10+100: the OUTER loop iterates correctly all three times, the INNER
loop runs once per outer iteration.

### Diagnosis

The emitted labels are all structurally correct — both loops get
`_start`/`_end`/`_continue`/`after_`, via the original `outerWhileLoop` path.
The defect is drop placement, the same family as Bug B in the fixed issue but a
THIRD emission site: `processChainedBranch`'s "no more awaits" branch
(`src/codegen/async/state-machine.ts`, the `else` that emits
`chainedBranch.deferredDropExpressions` inline at indent 6). It emits the
enclosing match arm's scope-end drop of `inner` at the top of the inner loop's
resume state, so `inner` is freed during the first iteration and the loop
condition then re-reads freed memory:

```c
      switch (sm->cond_branch_0) { case 4: { count += f; break; } }
      fn_..._drop(sm->var_..._inner);          // <-- arm scope drop, every iteration
      }
      // Execute remaining code from while loop body and continue loop
      if (sm->while_loop_0_active) {
        i = i + 1;
      while_loop_0_continue:
        ... fn_..._len(sm->var_..._inner) ...   // <-- reads freed memory
```

### Attempted fix, and why it was reverted

Routing those drops into the enclosing loop's `condBranchPostWhileExprs` slot
made this shape correct (222) **but broke the nested repro** — that slot is
already claimed by `generateCondWithAwait` for the `if(...)` layer in shapes
that have one, and the two uses collide. Reverted.

The direction that should work is a DEDICATED field on the while-loop info
(e.g. `postLoopDrops`) emitted immediately after `after_while_loop_N:`, so it
cannot contend with `condBranchPostWhileExprs`. Not attempted — see the note on
verification cost below.

## Hole 2 — nested await-loops over REAL I/O futures crash intermittently

`issues/repros/nested-await-loop-undefined-label.yo` (which awaits
`exists(Path, io)` rather than `yield`) compiles and prints `probe=6`, but only
sometimes:

```
run1: rc=0   probe=6
run2: rc=138          # SIGBUS
run3: rc=133          # SIGTRAP
run4: rc=133
run5: rc=133
```

Roughly 5 failures in 6, with and without `MallocScribble`. It is memory
corruption, not a wrong answer.

### What is and isn't implicated

- A **single, non-nested** `exists` loop is stable (5/5 correct) — so this is
  not the async-I/O path on its own.
- The **same nested shape over `yield`** is stable (5/5, and the two regression
  tests in `tests/async_await.test.yo` pass 5/5) — so it is not the nested
  lowering on its own.
- It is the combination: nesting plus a future that can complete
  asynchronously. The timing dependence is consistent with the inline
  fast-path (`__yo_inline_budget`) vs. real suspension taking different routes
  through the states.
- **Not** the state-machine dispose double-dropping: dispose is gated on
  `state == -2` (abort), and the normal path's drop of `inner` sits in the
  post-while block, which runs once per outer iteration as it should.

Undiagnosed beyond that. The next step is to find which value is freed while
still live — the per-inner-iteration temps (`Path.new(f.clone())`) and the
outer continue block's drop of the match scrutinee temp are the two candidates
visible in the emitted C.

## Why these are filed rather than fixed

The async state-machine emitter miscompiles silently when it is wrong, and this
session already produced one such attempt (the `condBranchPostWhileExprs`
collision above) that turned a green repro into a SIGBUS. Each candidate needs
the full battery to say anything, and the two fixes already landed are worth
getting through CI on their own before more is stacked on them.

## Verify

Hole 1 (expect `A=222`, currently `A=111`):

```
./yo-cli compile issues/repros/nested-await-loop-outer-no-own-await.yo --release -o /tmp/holeA && /tmp/holeA
```

Hole 2:

```
./yo-cli compile issues/repros/nested-await-loop-undefined-label.yo --release -o /tmp/probe
for i in 1 2 3 4 5 6; do /tmp/probe; echo "rc=$?"; done
```

Expected once fixed: `probe=6`, rc=0, six times out of six.
