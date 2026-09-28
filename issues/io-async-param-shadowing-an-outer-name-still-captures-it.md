# An `io.async` closure whose parameter shadows an outer name still captures the outer value

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit (`plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/io-async-param-shadowing-an-outer-name-still-captures-it.yo`:

```rust
_a :: (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))(io.async((io : Io) => { io.await(yield(io), io); x }));
_b :: (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))(io.async((io2 : Io) => { io2.await(yield(io2), io2); x }));
```

The emitted capture structs:

```c
struct …_struct { __yo_t_… io; int32_t x; };   // _a: captures the SHADOWED outer `io`
struct …_struct { int32_t x; };                // _b
```

The body of `_a` never reads the outer `io` (its own parameter shadows it),
yet the capture struct holds a dead 32 B copy of it. That is 32 of the 152
bytes of a one-await state machine. `io.async((io : Io) => …)` is the
idiomatic spelling used throughout std, so almost every std future carries
the dead copy. It is harmless for `Io` today (no RC fields). For a shadowed
RC value, it would also retain the value for the future's whole life.

## Root cause

The closure capture analysis collects free names without subtracting the
closure's own parameters when a parameter has the same name as an outer
binding. The exact site is not yet pinned; it is the io.async closure's
capture collection feeding `expr_info_capture_type`.

## Fix direction

Parameters bind before the body, so the free-variable walk must start from
an environment in which they already shadow outer names. Regression test:
assert via `--emit-c` that the capture struct of the repro's `_a` has only
`x`, or, behaviourally, that a shadowed RC outer value is released when the
outer scope ends and not when the future dies.
