# async codegen: duplicate `while_loop_N_continue` labels when awaits sit in nested cond arms inside nested whiles

**Status: OPEN (unminimized).** Found 2026-08-22 implementing
`follow_symlinks` in `std/fs/walker.yo` (S0 C9).

## Symptom

clang rejects the emitted C:

```
tests/fs/.yo_selftest_batch_1_0.bin.c:18661:7: error: redefinition of label 'while_loop_3_continue'
tests/fs/.yo_selftest_batch_1_0.bin.c:18711:7: error: redefinition of label 'after_while_loop_3'
```

Both duplicated labels sit under `// Execute remaining code from outer while
loop body` blocks guarded by `if (sm->while_loop_3_active)` — the state
machine's loop-resume path emits the SAME loop's continue/after labels in
more than one state.

## Trigger shape (unminimized)

Inside `io.async`, a `while` (stack loop) containing a `while` (entries
loop) whose body has a `match` with an arm containing:

```rust
follows_dir := cond(
  options.follow_symlinks => e.io.await(_file.is_dir(...), e.io),
  true => false
);
cond(
  follows_dir => {
    canon := e.io.await(_file.canonical(...), e);
    ...
  },
  true => ()
);
```

i.e. TWO award points inside cond arms, inside a match arm, inside
while-in-while. The exact pre-restructure diff of `std/fs/walker.yo` that
reproduces is in the reflog of branch `std/s0-https-refuse` (the walker was
restructured to hoist the awaits into a separate post-loop while, which
compiles fine).

`yo check` passes over this (evaluator-only); it fails only at the C
compile — same detection story as the other async state-machine
restrictions (AGENTS.md "check misses async codegen rules").

## Next steps

1. Minimize: reproduce in `tmp/fixme.yo` with a small async fn of the same
   nesting shape.
2. Fix the state-machine emitter (`src/codegen/async/`) to dedupe the
   loop-resume label emission (emit the resume path once per loop, or
   qualify labels per state).
3. Possibly related to `issues/async-await-nested-if-lost-continuation.md`
   (also deep-nesting async emission); check whether one fix covers both.
