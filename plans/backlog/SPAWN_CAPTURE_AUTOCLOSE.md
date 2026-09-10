# Auto-close across `Thread.spawn`: a `Sender` in a spawn closure never drops

**Status:** BACKLOG (written, not started) — 2026-09-11. Written while landing
the `Sender`/`Receiver` split in `std/sync/channel.yo`
(`plans/STD_API_STABILIZATION.md`, Concurrency).

**Underlying defect:** `issues/spawn-closure-captures-never-dropped-leak.md`
(OPEN, pre-existing, filed as a memory leak).

## The gap

`Sender`'s `Dispose` decrements the queue's sender count and closes the
channel on the `1 -> 0` transition. That is what makes the split's promise
work: a `Receiver` learns the producers are finished without anyone calling
`close()`.

A `Sender` **moved into a `Thread.spawn` closure never runs that `dispose`**.
The spawn emitter (`src/codegen/exprs/parallelism.yo`) heap-copies the capture
struct and emits `__yo_free(closure)` in its wrapper, but no `___drop` of the
struct's fields, because the self-hosted compiler synthesizes no
`___dup`/`___drop` for an anonymous closure-capture struct and both the dup at
the call site and the drop in the wrapper are emitted only when one resolves.
The `+1` taken when the capture struct is built is therefore never released,
the handle's refcount never reaches zero, and its `dispose` never runs.

Values still flow: only the auto-close is lost, and the channel behaves as it
did before the split (someone must call `close()`).

## Measured

`issues/repros/thread-spawn-capture-blocks-channel-autoclose.yo` — the same
sender, dropped two ways (macOS arm64, `--optimize 2`, 2026-09-10):

```
plain scope: closed after the sender's scope ended = true
spawn capture: closed after join                   = false
```

The `false` is the whole bug. An `io.async` capture releases correctly, so
`std/async/channel`'s producer tasks close their channel normally — this is
specific to the OS-thread spawn path (`__yo_thread_spawn` /
`__yo_worker_spawn`).

## Blocked call site

`std/sync/channel.yo`, `Sender`'s `Dispose` impl, for the shape a Rust reader
writes first:

```rust
tx2 := tx.clone();
t := Thread.spawn((io) => { tx2.send(v); });   // tx2's dispose never runs
```

## Options

1. **Fix the codegen (RECOMMENDED).** The fix direction is already written in
   the issue: synthesize `___dup`/`___drop` for closure-capture structs, or
   have `_generate_spawn_wrapper` fall back to `generate_drop_code_for_value`
   over the capture struct's runtime fields, and drop the capture value at the
   call site once ownership has moved to the heap copy. It also removes an
   unbounded ~344 B-per-spawn leak that every threaded program pays today.
   Cost: a compiler change, so it needs the dup/drop emit-diff gate (a
   mispaired drop here is a double-free, not a leak) and a compiler rebuild —
   which is why it was not bundled with the std-side PR.
2. **A `Sender.release()` on the std side.** REJECTED: it is exactly the manual
   `close()` the split exists to remove, and it would be the only method in
   std whose documented reason to exist is "the compiler leaks your capture".
3. **A `spawn_with(sender, cb)` that hands the producer in as an argument.**
   REJECTED: it encodes a codegen bug in a public signature, and every future
   captured-handle type would want its own variant.
4. **Document the mint-inside-the-thread pattern.** SHIPPED as the interim
   answer, because it is sound rather than a trick: the parent holds one
   `keeper` sender so the count cannot reach zero while the workers start, and
   each worker mints its own sender inside its body, where the local's
   scope-end drop DOES run.

   ```rust
   rx := Channel(i32).receiver(usize(16));
   {
     keeper := rx.sender();
     w := Thread.spawn((io) => {
       tx := rx.sender();
       tx.send(i32(7));
     });
     w.join();
   };                       // keeper drops -> closed
   ```

   Covered by `tests/sync/channel.test.yo`, "a sender per thread: the last one
   to finish closes the channel".

## Recommendation

Do option 1 as part of whoever next touches the spawn emitter, and drop the
`## Producers on other threads` caveat from `std/sync/channel.yo`'s header
when it lands. Until then option 4 is the documented pattern, and the
`Receiver`-in-the-thread direction (a consumer thread parked in `recv` while
the parent's senders drop) needs no care at all — the parent's drops are real
drops. That direction is what `tests/sync/channel.test.yo`'s two wake-up tests
exercise.
