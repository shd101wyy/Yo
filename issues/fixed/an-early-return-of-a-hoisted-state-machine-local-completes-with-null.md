# An early `return(x)` of a hoisted state-machine local completes its future with NULL

**Status:** FIXED 2026-09-28.
**Found:** CI on PR #975. Every PR since #973 failed "Bootstrap fixpoint stage-3",
the cross-emit jobs, "Compiler build inside 8 GB" and "Evaluator memory ratchet" at
"Fetch the project's Yo dependencies": the stage-2 compiler (the tree built by its own
compiler) segfaulted (exit 139) in `yo install --locked` on a cold cache. Stage-1 arms
could not see it.
**Bisected:** `git bisect run` over `v0.2.45..cccb47c6e`. The first bad commit is `2b50ef1a8`
(#973, "an awaited match scrutinee and hoisted state-machine locals are released at
completion").

## Symptom

```rust
read_list :: (fn(early : bool, io : Io) -> Impl(Future(ArrayList(i32), Io)))(
  io.async((io : Io) => {
    out := ArrayList(i32).new();
    out.push(i32(7));
    _ready := io.await(ready(io), io);   // `out` lives across the await: sm->var_out
    if(early, {
      return(out);                       // completed with NULL
    });
    out
  })
);
```

Awaiting `read_list(true, io)` and reading the list segfaults. The compiler's own
`_read_projects` (`src/fetch.yo`) has this shape, and it takes the early return when the
projects registry does not exist yet, i.e. on a cold cache.

## Root cause (measured from the emitted C)

```c
__yo_t_…* out = sm->var_out_…;                 // the deferred dup's temp
__yo_incr_rc(sm->var_out_…);                    // +1 for the caller
__yo_decr_rc(sm->var_out_…); memset(&sm->var_out_…, 0, …);   // #973's completion drop
sm->result = sm->var_out_…;                     // read AFTER the drop: NULL
```

#973 made the completion's scope-end drops release state-machine locals hoisted into the
struct, which fixed their leak. The dup/drop pair is balanced. But the state-machine branch of
the return generator (`codegen/exprs/return.yo`) computed the future's result after the
drops, and a returned hoisted local renders as its `sm->var_<id>` field, which the drop had
just zeroed.

## Fix

A state-machine return takes its value into a fresh C temp (`__yo_sm_ret_N`) before the
scope-end drops, and completes the future from that temp.

## Verification

- The repro prints `early 1` / `late 2`, runs clean under Guard Malloc, and `leaks --atExit`
  reports 0 leaks.
- `fixpoint_only.sh` gives FIXPOINT_HOLDS, and the stage-2 binary's cold-cache
  `yo install --locked` exits 0 (it exited 139 before).

## Test

`tests/async_await.test.yo`: "an early return of an awaited-across local completes with the
value". It fails on develop (exit code 11) and passes with the fix.
