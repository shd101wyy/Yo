# `Thread(V).join()` fails on a move-only `V`

**Severity:** S2 — a thread whose body returns a move-only value cannot be joined: `t.join()` is E0901 inside `std/sync/channel.yo`, so a `Thread(File)`, a `Thread(V)` over a `Box` field (and, after B8, a `Thread(String)`) is rejected although `Thread(T)` admits any `Send` `T`.

**Status:** open. Filed 2026-10-24 from the VBD lookahead (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4, P1), reproduced with the v0.2.68 seed and with the tree binary on `feat/v3-std-cell-free-resources`. V3's std half does not fix it: it moves `Thread`'s state into a `Box`, but `join` still reads the body's result through `Channel(T).try_recv`, which `std/sync/channel.yo` implements by copying the element out of the ring buffer.

## Reproducer

`issues/repros/2026-10-24-thread-join-of-a-move-only-value.yo`:

```yo
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
V :: struct(b : Box(i32));
main :: (fn() -> unit)({
  t := Thread(V).spawn((io : Io) => V(b : box(i32(41))));
  v := t.join();
  println(`${v.b.* + i32(1)}`);
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `element_ptr.*`, whose type `V` is move-only, and it cannot be moved either: it is the value a pointer or reference points to, and that storage still owns it (a dereference copies, it never moves).
    --> ./thread-join-of-a-move-only-value.yo:6:9
note: raised here, inside the standard library
    --> std/sync/channel.yo:318:28 (the tree's std; line 323 in the v0.2.68 bundle)
318 |     (val : T) = element_ptr.*;
```

Expected: it prints `42`.

## Root cause

`Channel(T)` stores, receives and drops its elements with plain dereferences (`std/sync/channel.yo`, the `send`/`try_send`/`recv`/`try_recv` slots and the drain in its `Drop`). A dereference copies, so every instantiation at a move-only `T` is E0901. `Thread(T).join` reaches it through `self._cell._result.try_recv()`.

## Fix

Lookahead P1: move the element out with `__yo_ptr_read`, store it with `__yo_ptr_write`, and drop the undelivered ones with `drop_in_place`. The regression test is the move-only rows P1 adds to `tests/thread.test.yo` (this reproducer as a test, plus a `Thread(File)` round trip).
