# TS: a bare `if` whose branch awaits and early-returns is SILENTLY SKIPPED

**Status: OPEN.** Found 2026-08-10 while reducing the stage-2 empty-RHS
errors. **The self-hosted compiler gets this RIGHT; the TS reference is
wrong** — the fourth "yo-self ahead" instance.

Reproducer: [`repros/ts-bare-if-await-early-return-skipped.yo`](repros/ts-bare-if-await-early-return-skipped.yo)

```rust
io.async((aio : Io) => {
  if(n == usize(0), {
    existing := aio.await(fetch_name(aio), aio);
    if(existing.len() > usize(0), { aio.await(yield(aio), aio); });
    return(String.from("empty-path"));
  });
  return(String.from("deps-path"))
})
```

```
$ ts-compiled:   probe(0) → "deps-path"   ← WRONG (branch skipped, exit 0)
$ self-compiled: probe(0) → "empty-path"  ← correct
```

Same family as issues/fixed/async-if-with-await-in-while-body-emits-nothing.md
(bug #9) — that fix covered `if` as a WHILE BODY; the bare-statement `if`
with an await-BINDING + nested if + early return takes a different dispatch
path. `run_fetch`'s prune-stale-lock branch in yo-self/fetch.yo is exactly
this shape, so `yo fetch` with no deps behaves differently under the two
compilers today (TS never prunes).

Fix in src/codegen (generateAwaitExpression / the statement dispatcher for
if-via-macroExpansion at the TOP level of an async body segment), regression
test alongside the bug-#9 one. Grep the emitted C for the missing
cond_branch assignment first.
