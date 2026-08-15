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
The defect is drop placement: the enclosing match arm's scope-end drop of
`inner` lands at the top of the inner loop's resume state, so `inner` is freed
during the first iteration and the loop condition then re-reads freed memory:

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

### Which emitter produces that drop is still UNKNOWN

An earlier revision of this file blamed `processChainedBranch`'s "no more
awaits" path in `state-machine.ts`. **That was wrong.** Tagging every
`${dropCode}` emitter in `src/codegen/async/state-machine.ts` and
`state-code-gen.ts` with a distinct `/*DROPSITE_*/` marker and recompiling this
repro shows only ONE of them firing in that region — `SM1158`, and it emits the
`__yo_decr_rc(await_future_0)` line, not the `inner` drop. So the drop comes
from outside the async emitters: the generic scope-exit drop machinery
(`src/codegen/exprs/begin.ts`, `atom.ts`, `other-fn-call.ts` all emit
`${indent}${dropCode};`) is the place to tag next.

That matters for the fix, because a deferral only works if it is applied where
the drop is actually produced.

### Two attempts, both reverted

1. Routing the drops into the enclosing loop's `condBranchPostWhileExprs` made
   this shape correct (222) but **broke the nested repro into a SIGBUS** — that
   slot is already claimed by `generateCondWithAwait` for the `if(...)` layer,
   and the two uses collide.
2. A DEDICATED `postLoopDrops` field on the while-loop info, emitted right after
   `after_while_loop_N:`, avoids that collision and does emit correctly (the
   drop code must be generated where it is COLLECTED, not where it is emitted —
   the state-machine variable mapping is only set up at the collection point, so
   deferring an `Expr` yields a bare `inner` and a C compile error; defer the
   generated string instead). But it changed nothing here, because the drop is
   not produced by the site it hooks. Reverted.

The `postLoopDrops` design is still the right shape for the eventual fix; it
just needs to be wired to the emitter that actually produces this drop.

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

### Root cause: ONE post-loop slot, TWO clients

Localised with Guard Malloc (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`
under lldb, against the emitted C rebuilt `clang -g -O0`), which traps at the
offending access instead of downstream in `mfm_alloc`:

```
frame #0: __yo_decr_rc(ptr=0x340147fe0) at h2crash.c:4957
frame #1: fn_yodb917980_id_44___drop  (Path)  at h2crash.c:11945 [inlined]
frame #2: _yo38915498_temp_46221_resume       at h2crash.c:13812
```

`h2crash.c:13809-13814` is:

```c
      // Outer cond branch 2 remaining code (chained)
      if (sm->cond_branch_0 == 2) {
      if (sm->await_future_0 != NULL) { __yo_decr_rc((void*)sm->await_future_0); };
      fn_..._drop(sm->var_..._temp_46112);   // the OUTER arm's Path.new(d.clone())
      fn_..._drop(sm->var_..._temp_46111);   // and its String
      }
```

That is the OUTER match arm's scope-end code, emitted inside the INNER loop's
resume state — so a `Path` built once per OUTER iteration is dropped on every
INNER iteration. A double-free, hence the timing dependence and the corrupted
heap.

It is the same defect as Bug B in the fixed issue, reaching the same place by a
different route: the fix routes a branch's post-loop code into the nested loop's
`condBranchPostWhileExprs`, but **declines when that slot is already occupied**
— and here `generateCondWithAwait` has already claimed it for the `if(got, …)`
layer. Declining falls back to chaining, which emits at the top of the resume
state. One slot, two legitimate clients.

### The fix

Give the slot room for both layers, in source order: either make
`condBranchPostWhileExprs` a LIST that clients append to, or add the dedicated
`postLoopDrops` field (see Hole 1) and route the second client there. A list is
the more principled of the two — there is nothing special about "two", and the
consumer already iterates `exprs`.

Do NOT simply overwrite or merge under the existing entry's guard: the two
layers dispatch on DIFFERENT `cond_branch_N` fields (`cond_branch_0 == 2` here
versus the inner layer's own), so a merge is only sound when the surviving entry
is unconditional (`skipCondBranchCheck`). Relying on that is fragile.

Both compilers need it; `yo-self/codegen/functions/context.yo`'s
`CondBranchPostWhileExprs` is a `ref(struct(...))` in the same single-slot shape.

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
