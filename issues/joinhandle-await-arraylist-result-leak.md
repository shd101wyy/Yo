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

## Investigation update

Tried to reproduce the leak with simpler patterns (under ASan, default
test-runner sanitizer):

1. `io.spawn` + `JoinHandle.await` returning `ArrayList(i32)` — **no leak**
2. `io.spawn` + `JoinHandle.await` returning `ArrayList(u8)` — **no leak**
3. `io.spawn` + `JoinHandle.await` returning `String` (template literal) — **no leak**
4. Two parallel `io.spawn` of futures returning `ArrayList(u8)` — **no leak**
5. The exact pattern with `using(io, exn)` and `Exception` handler installed
   via `given(exn)`, two parallel spawns returning `ArrayList(u8)` — **no leak**

Looking at codegen:

- `generateJoinHandleAwait` (`src/codegen/exprs/await.ts:438-448`) DOES dup
  the result when it contains RC types.
- `disposeFunctionName` (`src/codegen/exprs/async.ts:1585-1589`) for
  sync_fut_t DOES drop the result field on `state == -1`.
- Full SM dispose (`src/codegen/exprs/async.ts:826-840`) ALSO drops the
  result field on `state == -1`.

The previously reported leak in `std/process/command.yo` `output()` may
have been caused by a different bug (likely related to
`dyn(IOError.from_errno(...))` interacting with closure captures — see
`issues/box-forall-V-bound-to-iorerror-after-impl-IOError-Error.md`).
The workaround using `io.await` directly is still in place.

## Status: not currently reproducible

Cannot reproduce with simple test cases under ASan. May have been fixed
incidentally by other RC/codegen changes, OR may only manifest with the
real `_drain_fd` scenario (involving `dyn(IOError.from_errno(...))` which
has its own pending issue).

If the workaround in `output()` is removed and the leak reappears, this
issue should be reopened with a fresh investigation.
