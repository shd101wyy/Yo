# In an `io.async` body, a nested arm's post-loop statements also run when a SIBLING nested arm was taken

**Status:** FIXED 2026-09-11 (`fix/async-nested-match-dead-arm`).
**Found:** 2026-09-11, probing the nested-dispatch fix with a nested cond
whose arm loops with an await and whose enclosing arm has trailing
statements. Reproduces on the pre-fix compiler.
**Severity:** medium — silent wrong control flow, `check` clean.

## Reproducer

`issues/repros/async-post-while-code-runs-for-a-sibling-nested-arm.yo`:

```rust
cond(
  (mode == usize(0)) => { log.push_str("plain;"); },
  true => {
    cond(
      (mode == usize(1)) => { log.push_str("no-loop;"); },
      true => {
        while(runtime(i < usize(3)), { r := e.io.await(step(i, e.io), e); i = r; … });
        log.push_str("loop-done;");          // ran for mode == 1 too
      }
    );
    log.push_str("outer-tail;");
  }
);
```

`mode == 1` printed `no-loop;loop-done;outer-tail;end`.

## Root cause

A while loop's `cond_branch_post_while_exprs` slot has several clients — the
looping arm's own post-loop statements and the enclosing arm's trailing
statements — and `merge_cond_branch_post_while_exprs` concatenated their
statements into ONE list under ONE guard. When the clients' arms differed the
merge set `skip_cond_branch_check` and the whole block ran unconditionally
(and even the union guard `code ∈ {loop arm} ∪ {enclosing arm}` would have
let the loop arm's statements run for the synchronous sibling arm, whose code
is in the enclosing arm's set).

## Fix

`CondBranchPostWhileExprs` keeps the merged statement list (the order matters
for chaining an additional await through the whole sequence) and records its
clients (`part_codes`, `part_lens`); `_emit_post_while_cond_branch` emits each
client's statements under that client's own `_codes_guard`. A single-client
slot emits exactly what it did before. The `guards_disagree` unconditional
fallback is gone.

**Gate:** `tests/async_await.test.yo` — "a nested arm that loops with an
await runs its post-loop code for that arm only".
