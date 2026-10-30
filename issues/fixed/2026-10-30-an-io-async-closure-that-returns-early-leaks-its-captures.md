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

## Wider than `io.async`

The cause is the bare `return` atom, not the async lowering. Any function
whose body leaves through a bare `return` outside a state machine skipped
every scope-end drop on that path. That covers its locals, its owned
parameters and an FnOnce closure's unmoved captures. `return()`, the
zero-argument call, was not affected. Develop `b7e873958`:

```yo
_BareReturnProbe :: struct(n : i32);
// impl(_BareReturnProbe, Drop(...)) counts the drops
_bare_return_local :: (fn(early : bool) -> unit)({
  p := _BareReturnProbe(n : i32(1));
  cond(
    early => {
      return;
    },
    true => ()
  );
  assert(p.n == i32(1), "the fall-through path reads the local");
});
```

`_bare_return_local(true)` never ran `p`'s `Drop`. A local `Rc` leaked its
allocation the same way. The compiler's own `src/` spells the bare form at
82 sites.

## Root cause

The expression dispatcher (`src/codegen/exprs/generation.yo`) sends a
`return(...)` call to `generate_return` (`exprs/return.yo`). A bare `return`
is an atom, so it went to `generate_atom` (`exprs/atom.yo`). Inside a state
machine, `generate_atom` emits the pending drops and completes the future.
Outside one, it returned the C keyword `return` and emitted nothing. The
evaluator handles both forms the same way: `return` and `return()` are both
unit returns (`evaluator/exprs/begin.yo`). It also attaches a bare `return`'s
early-return-only drops to the atom (`_m3_attach_to_returns`). Codegen
emitted none of them.

The `io.async` repro has no await, so the closure runs as a plain C call
(`…_sync_fut_t`). That puts its `return;` on the non-state-machine path. The
task's dispose drops the capture list only when the body never ran
(`state == 0`). After the body runs, the FnOnce body owns the captures and has
to release them itself.

## Fix

Outside a state machine, the dispatcher now sends a bare `return` to
`generate_return`. That is the `return()` path: the expression's own and
early-return-only drops, then the pending scope drops through
`_keep_pending_drop`, which exempts a tagged FnOnce capture drop from the C
declaration gate, then `return`. Inside a state machine the atom keeps its
completion path, which carries #1663's move-flag guards.

## Test

`tests/async_await.test.yo`, "Test a bare return releases an io.async body's
captures and a function's locals". It counts `Drop` calls, so it fails without
the leak verdict too. On develop `b7e873958` the counts are 0, 0 and 1 where
1, 2 and 3 are expected. "Test early return from async block" passes with the
leak verdict on again.
