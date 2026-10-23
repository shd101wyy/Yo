# An aborted task drops a `Box` local it never stored

**Severity:** S1 — a task that throws before a `Box`-holding local is stored crashes when it is aborted (SEGV reading 16 bytes below null), so `read_to_string` on a missing path crashed once `File` held a `Box`.

**Status:** fixed 2026-10-23 (branch `feat/v3-std-cell-free-resources`). Found while moving the cell-free resources onto `Box` (plans/VALUES_BY_DEFAULT.md V3, std half): `tests/fs/file.test.yo`'s "a path with an interior NUL never reaches the file at its prefix" crashed under AddressSanitizer. The bug is older than that change. Any `Box`, `RefCell` or async `Mutex` local that lives across an await had it on develop `5136a2b9d`.

## Reproducer

```yo
{ IoExn, Exception } :: import("std/error");
{ println } :: import("std/fmt");
_St :: struct(fd : i32, closed : bool);
impl(
  _St,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      if(!self.closed, {
        println(`close ${self.fd}`);
        self.closed = true;
      });
    })
  )
);
R :: struct(_cell : Box(_St));
impl(R, get : (fn(self : &Self) -> i32)(self._cell.fd));
_make :: (fn(fail : bool, io : Io) -> Impl(Future(R, IoExn)))(
  io.async(e => {
    if(fail, {
      e.exn.throw(dyn(`boom`));
    });
    R(_cell : box(_St(fd : i32(7), closed : false)))
  })
);
_outer :: (fn(fail : bool, io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    r := e.io.await(_make(fail, e.io), e);
    w := e.io.await(_make(false, e.io), e);
    v := (r.get() + (w.get() - i32(7)));
    return(v);
  })
);
_run :: (fn(fail : bool, io : Io) -> bool)({
  exn := Exception(
    throw : (
      err -> {
        unwind(false);
      }
    )
  );
  ioe := IoExn(io : io, exn : exn);
  v := io.await(_outer(fail, io), ioe);
  v == i32(7)
});
main :: (fn(io : Io) -> unit)({
  println(`threw: ${!_run(true, io)}`);
});
export(main);
```

`yo compile repro.yo --sanitize address` and run it:

```
==2018051==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000004
```

`r` lives across the second await, so it has a slot in `_outer`'s state machine. The first await throws, so `r` is never stored. The abort then runs the state machine's `dispose_locals`, which drops `r`'s slot.

## Root cause

The state machine is zero-initialized, and its abort path drops every local slot. For a moved-from slot it zeroes the slot first (`if (sm->__yo_mv_…) memset(…)`). That relies on one invariant: dropping a zeroed value is a no-op. Every reference handle keeps it, because its release null-checks. `Box`'s `Drop` did not. It called `drop_in_place(null)` and then read the owner prefix at `null - 16`.

## Fix

`Box`'s `Drop` (`std/prelude.yo`) is a no-op when the cell pointer is null. It reads the pointer as an `Option(*T)`, which has the same representation, with null as `.None`. A zeroed box therefore owns nothing, the way a zeroed reference handle owns nothing. A `Box`-celled resource (`File`, `TcpStream`, …) is covered with no change of its own: its state's `Drop` never runs for a slot that was never stored.

This does not cover a user value type whose own `Drop` runs on a zeroed slot. That is `issues/2026-10-23-an-aborted-task-runs-a-user-drop-on-a-local-it-never-stored.md`, which needs per-slot initialization flags in the state machine.

## Verification

`tests/move_only.test.yo`, "move-only: an aborted task drops a Box-holding local it never stored as nothing": it crashes before the fix and passes after it, under both the v0.2.68 seed and the tree binary. `tests/fs/file.test.yo` passes.
