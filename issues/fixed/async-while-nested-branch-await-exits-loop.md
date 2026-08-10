# Async while: an await nested TWO branch levels deep silently exited the loop after one iteration

**Status: FIXED in BOTH compilers** (2026-08-10). Found while porting
`unsafe-report`: a hand-rolled directory-walker loop (awaits under nested
`if`s inside an async while) processed exactly one directory and stopped —
rc=0, no diagnostic. Minimal repro: a while whose body awaits inside a
branch that contains ANOTHER branch-nested await:

```rust
while(runtime(stack.len() > usize(0)), {
  n := match(stack.pop(), .Some(x) => x, .None => usize(0));
  if(n > usize(1), {
    aio.await(yield(aio), aio);
    if(n > usize(2), {
      aio.await(yield(aio), aio);
      stack.push(n - usize(1));   // never ran before the loop-exit check
    });
    count = (count + usize(1));
  });
});
```

Expected 2 iterations with work; got 1. Both `if` and `cond` nesting, both
compilers. ONE await under a single branch level (the std/fs/walker shape)
was fine — the breakage needs the second nested level, because that is what
routes the second await through the BRANCH chain instead of the while chain.

## Root cause (from the emitted C)

The while-loop continuation chain (`asyncWhileLoopInfo`) propagates only
through the while BODY's top-level remaining expressions. An await nested in
a branch chains through `asyncCondBranchInfo` instead, which never forwarded
the while entry. Two consequences, visible in the resume states:

1. The loop's own resume state emitted its loop-back UNCONDITIONALLY after
   the branch switch — re-evaluating the condition BEFORE the just-stored
   nested await (and everything after it, e.g. the `push`) ran. The stale
   condition was false, so the loop exited.
2. The nested await's resume state had no while entry at all: it ran the
   branch remainder and the chained outer layer, then COMPLETED the future —
   no loop-back existed anywhere.

## Fix (both compilers)

- When the branch remaining-code generator chains to the next await
  (`foundAdditionalAwait`), it now FORWARDS the enclosing while entry to that
  next await index (fresh object in yo-self — `WhileLoopInfo` is a ref type,
  so mutating the handle would alias the previous entry).
- The while resume state treats a pending branch-nested await as
  pre-chained (`segment.awaitPoint.isInsideCond` + a forwarded entry at that
  index): it skips its own loop-back exactly like the existing
  `chainedToNextAwait` path. The branch-not-taken runtime path reaches the
  next state through the existing `await_future_N == NULL` state transition,
  and the forwarded entry loops back from there.

`src/codegen/async/state-machine.ts` + `yo-self/codegen/async/state_machine.yo`.

## Tests

`tests/async_await.test.yo` +2 ("await nested in an if/cond inside an
if/cond inside an async while keeps looping") — failed with `1 != 2` before
the fix, pass under both compilers after. Suite 161/161.
