# A nested bare block containing an await, as a statement of an async cond/match arm, was silently dropped

**Status: FIXED 2026-09-12** (`p1/store`). Found when every dependency tree in the
new content-addressed store hashed to the same value: `compute_content_hash`'s file
arm had been written as `{ …; content := e.io.await(read(...), e); …; }` inside the
`if(item.is_dir, {…}, {…})` of its DFS loop, and the whole block — the `file:` prefix,
the read, the hasher update — vanished from the emitted state machine. Only the
`dir:` lines were hashed, so three different repositories shared one store entry and
the transitive-dependency build imported the wrong package.

## Symptom

```rust
io.async((e : IoExn) => {
  (total : usize) = usize(0);
  (i : usize) = usize(0);
  while(i < paths.len(), {
    p := paths(i).clone();
    i = (i + usize(1));
    if(p.ends_with(String.from("/")), {
      total = (total + usize(1000));
    }, {
      {                                                 // a nested bare block …
        bytes := e.io.await(read(Path.new(p.clone()), e.io), e);   // … with an await
        total = (total + bytes.len());
      };
    });
  });
  total
})
```

returned `1000` for `["a.yo", "dir/", "b.yo"]` — the file branch's block never ran.
The same block written flat (its statements directly in the arm) returned the byte
count. The same shape as a `match` arm's statement behaved the same way; as a
TOP-LEVEL statement of the body it was rejected instead, with

```
internal compiler error: … `io.await` is not supported in this position inside an `io.async` block (expression: FnCall, function: `begin`).
```

## Root cause

The async lowering splits statement LISTS at their awaits: `split_body_at_suspension_points`
for the body, `generate_while_body_with_await` for a loop body,
`generate_cond_branch_with_await` for an arm. Each walks the `begin`'s arguments and
classifies the statement that carries the await — `x := io.await(...)`, a bare await,
`x := cond/match(...)`, a bare nested `cond`/`match`, a nested `while`. A statement
that is itself a `begin` matched none of the arms of that classification: the top-level
splitter's position check reported it, but the cond-branch emitter's `if/else` chain
simply fell through — the branch header (`sm->cond_branch_N = …`) was emitted, no
future was stored, no remaining code was queued, and the resume's `case` for the arm
was empty. `_emit_cond_branch_remaining` then had nothing to emit either.

## Fix

`flatten_nested_await_blocks` (`src/codegen/exprs/async.yo`), run on the closure body
by `io_async_closure_body` — the one place every reader of an `io.async` body goes
through — before analysis or emission see it. Walking the body (through cond/match
arms, while bodies and macro expansions, never into a nested `io.async`), a `begin`
argument that is itself a `begin` CONTAINING an await of this body is spliced into
the enclosing list in place; a spliced block that holds another is examined again. A
block's scope-end drops (its `deferred_drop_expressions` and
`early_return_only_deferred_drop_expressions`) move onto the enclosing block's
ExprInfo, so the emitters that drain the enclosing block's drops release the nested
block's locals too. A ONE-statement block shares its node id (and so its ExprInfo)
with that statement — its drops are the statement's own — so only the wrapper goes.
The pass is idempotent (the body is read several times). Blocks without an await are
untouched: they are emitted as ordinary sync blocks.

Not a change to what a block MEANS: in an async body every local is a state-machine
field already, so the only thing the wrapper carried was the drop timing (block end →
enclosing block end), which cannot be observed — nothing after the block names its
locals.

## Gates

- `tests/async_await.test.yo` "nested bare block with an await …" ×3: the cond-arm shape
  inside a loop (returned the dir-only total on the develop compiler), the match-arm
  shape, and the top-level shape (an ICE before). Each sums file sizes through
  `std/fs/file.read`, and the nested and flat forms must agree.
- `src/fetch.yo`'s `compute_content_hash` keeps the FLAT shape with a seed-gate comment:
  the SEED compiler (v0.2.31) carries the bug, and a compiler whose own hasher ignores
  file contents would give every store tree one name.
