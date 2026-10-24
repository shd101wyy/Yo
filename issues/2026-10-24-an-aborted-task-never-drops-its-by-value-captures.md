# An aborted task never drops its by-value captures

**Severity:** S2 — a spawned `io.async` task that owns a value through a by-value capture (`io.async({ v }(io : Io) => …)`) and is aborted while suspended never drops it: the value leaks and its `Drop` never runs. Since V3 a std resource moved into a task is such a value, so aborting a task that owns a `UnixListener`, `TcpStream` or `File` leaks the descriptor until the process exits.

**Status:** open. Found 2026-10-24 by the leak-verdict run of `tests/net/unix.test.yo` ("aborting a task whose accept is pending releases it") on `feat/v3-std-cell-free-resources`, where the spawned server task now owns its listener. Reproduced without std resources on develop (`f271ed005` binary with develop's std), on the v0.2.68 seed and on the branch: the same 236-byte LeakSanitizer report on all three, so V3 only made it visible. CI runs that test with `YO_TEST_LEAK_VERDICT=0`, so it stays green there.

## Reproducer

`issues/repros/2026-10-24-an-aborted-task-leaks-its-by-value-captures.yo`:

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
V :: struct(b : Box(i32));
_task :: (fn(sink(v) : V, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ v }(io : Io) => {
    io.await(yield(io), io);
    io.await(yield(io), io);
    io.await(yield(io), io);
    println(`${v.b.*}`);
  })
);
main :: (fn(io : Io) -> unit)({
  h := io.spawn(_task(V(b : box(i32(7))), io), io);
  io.await(yield(io), io);
  h.abort();
  _r := h.await(io);
  println("done");
});
export(main);
```

```text
$ yo compile repro.yo --sanitize address --allocator system -o repro && ./repro
==ERROR: LeakSanitizer: detected memory leaks
Indirect leak of 152 byte(s) in 1 object(s) allocated from: ...
Indirect leak of 64 byte(s) in 1 object(s) allocated from: ...
Indirect leak of 20 byte(s) in 1 object(s) allocated from: ...
SUMMARY: AddressSanitizer: 236 byte(s) leaked in 3 allocation(s).
```

Without the `h.abort()` the program prints `7` and `done` and leaks nothing.

## Expected

Aborting a task drops what its state machine owns: its live locals (it does, `issues/fixed/abort-dispose-never-drops-string-option-and-value-struct-locals.md`) and its by-value captures, each once.

## Notes

- Not root-caused yet. The abort path (`FutureState.Aborted`, the abort-dispose emitted by `src/codegen/async/`) releases the task's live locals; the reproducer suggests the capture slots are not among what it releases.
- `tests/net/unix.test.yo`'s abort test is the leak-verdict regression run for the fix, with a direct test over the reproducer added to `tests/async_await.test.yo` under `pragma(Pragma.NeedsLeakVerdict)` (or the leak-verdict allowlist in `.github/workflows/leak-verdict.yml`).
