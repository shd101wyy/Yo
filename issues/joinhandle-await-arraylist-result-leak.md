# JoinHandle.await leaks RC-typed result values

## Summary

When an async task returns an RC-typed value (e.g., `ArrayList(u8)`, `String`, any `object(...)`) and the result is consumed via `JoinHandle.await()` (returned by `io.spawn`), AddressSanitizer reports leaks of the inner allocations even when the unwrapped value is later dropped normally.

## Reproduction

In `std/process/command.yo` `output()`, this pattern leaks:

```rust
out_task := io.spawn(_drain_fd(out_read), using(io, exn));
err_task := io.spawn(_drain_fd(err_read), using(io, exn));
stdout_buf := match(out_task.await(), .Some(b) => b, .None => ArrayList(u8).new());
stderr_buf := match(err_task.await(), .Some(b) => b, .None => ArrayList(u8).new());
```

while the equivalent sequential form is leak-free:

```rust
stdout_buf := io.await(_drain_fd(out_read));
stderr_buf := io.await(_drain_fd(err_read));
```

`_drain_fd` returns `Impl(Future(ArrayList(u8), IO, Exception))`.

ASan reports leaks rooted at the `ArrayList.new` and a subsequent `push` realloc inside the spawned future's resume function — i.e., the result struct stored in the future's `result` slot is never dropped.

## Suspected cause

`generateJoinHandleAwait` (`src/codegen/exprs/await.ts`) returns
`Option(T).Some(result)` by reading `state_view->result` directly from the
spawned future's state machine. The header is owned by the JoinHandle struct
(`__future : *(T)` field), but the JoinHandle is non-owning (`io.spawn` does
not bump the future's RC). When the JoinHandle is dropped, the result T inside
the future is not dup'd into the returned Option, so:

- If the future RC drops to 0 first → result is freed twice (or not at all if
  the dup was missing).
- If the JoinHandle outlives the future's main RC → the inner allocations
  remain reachable via `state_view->result` but are never dropped because the
  future's destructor doesn't know to drop the result field.

Either way, RC-typed results escape ownership tracking.

## Fix direction

`generateJoinHandleAwait` should `__yo_dup` the result when extracting it
into the returned `Option(T)`, and the future's destructor (or the await
itself once it has consumed the result) should drop the `result` field for
RC-typed `T`.

## Workaround

Use `io.await(...)` directly on the future for tasks whose result type is
RC-typed (no `io.spawn` + `JoinHandle.await`). This is what
`std/process/command.yo` `output()` currently does.
