# An `io.async` closure that returns early leaks its captures

**Severity:** S2 — a counted capture of an `io.async` closure whose body ends
in an early `return;` is never released: the program leaks the captured
allocation (48 bytes for an `Rc(RefCell(bool))`), and a local `yo test` run
with the leak verdict on fails `tests/async_await.test.yo`'s "Test early
return from async block".

**Found:** 2026-10-30, while replaying B13-b (errors by value) onto develop
`b8f86ebe2` (#1663, V2c). Not caused by B13-b: the same test fails the same
way with a compiler built from develop `b8f86ebe2` alone, and the reproducer
below leaks the same two blocks when compiled by the v0.2.72 seed. CI does not
see it because `test.yml` runs the language suite with
`YO_TEST_LEAK_VERDICT=0`.

## Reproducer

`issues/repros/2026-10-30-an-io-async-closure-that-returns-early-leaks-its-captures.yo`,
built with `yo compile <file> --std-path ./std --allocator debug`:

```yo
{ RefCell } :: import("std/sync/refcell");
{ println } :: import("std/fmt");
main :: (fn(io : Io) -> unit)({
  reached_middle := rc(RefCell(bool).new(false));
  rm2 := Rc.clone(reached_middle);
  task := io.async({ rm2 }(io : Io) => {
    rm2.with_mut(cur => {
      cur = true;
    });
    return;
  });
  io.await(task, io);
  println(`done ${reached_middle.with(cur => cur)}`);
});
export(main);
```

Output (develop `b8f86ebe2`):

```text
done true
debug allocator: peak 250.0 B, 9 allocations, live at exit: 2 blocks / 48 bytes
debug allocator:   leaked block #1: 32 bytes
debug allocator:   leaked block #2: 16 bytes
debug allocator: leak check failed: 2 blocks / 48 bytes leaked after main returned (exit status 23)
```

Deleting the `return;` line makes the leak go away (`live at exit: 0 blocks`).
The leaked blocks are the first two allocations, the `Rc(RefCell(bool))`
itself: the closure's captured share is never released, so the count never
reaches zero. The capture spelling does not matter: a moved capture
(`{ rm2 }`) and a capture-list clone (`{ reached_middle : Rc.clone(reached_middle) }`,
the test's spelling) leak the same way.

## Test

`tests/async_await.test.yo`, "Test early return from async block": fails with
the leak verdict on (the local default), passes once the early-return path
releases the closure's captures.

## Root cause

Not located yet. The likely place is the early-return path of the `io.async`
state machine, which does not emit the capture drops that the fall-through
completion emits; this is unconfirmed.
