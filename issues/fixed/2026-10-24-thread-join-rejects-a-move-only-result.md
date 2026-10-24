# `Thread(T).join()` and `Channel(T)` reject a move-only `T`

**Severity:** S2 — valid programs are wrongly rejected: a thread cannot return
a move-only value (`Thread(V).join()` with `V` implementing `Drop`, or holding
a `Box`), and a `Channel(V)` cannot carry one, so the value has to be wrapped
in a reference type to cross a thread.

**Status:** FIXED 2026-10-24 (branch `fix/thread-join-move-only`).

## Reproducer

```yo
{ Thread } :: import("std/thread");
Tok :: struct(n : i32);
impl(Tok, Drop(drop : (fn(self : &mut Self) -> unit)(())));
main :: (fn() -> unit)({
  th := Thread(Tok).spawn((io : Io) => Tok(n : i32(5)));
  v := th.join();
  ()
});
export(main);
```

`yo check` (v0.2.69, develop `27431e4be`):

```text
error[E0901]: use of moved value: cannot copy `element_ptr.*`, whose type `Tok` is move-only, and it cannot be moved either: it is the value a pointer or reference points to, and that storage still owns it (a dereference copies, it never moves).
    --> tmp/p1_probe.yo:12:10
note: raised here, inside the standard library
    --> std/sync/channel.yo:318:28
    |
318 |     (val : T) = element_ptr.*;
```

`Channel(Tok).recv()` fails the same way at `std/sync/channel.yo:264`.

## Root cause

`Thread(T)` carries the body's result through a capacity-1 `Channel(T)`, and
`join` reads it with `try_recv`. `Channel`'s ring buffer moved values in and
out with copies: `recv`/`try_recv` read a slot with `(val : T) = p.*` and then
cancelled the copy's extra share with `___drop(p.*)`; `send`/`try_send` stored
with `consume(p.* = value)`; `Channel`'s `drop` ended the buffered values with
`___drop(p.*)`. A dereference of a raw pointer copies, which is E0901 for a
move-only `T` (decision 19), so every instantiation at a move-only `T` failed.

## Fix

`std/sync/channel.yo` moves a value out of its slot with `__yo_ptr_read`, into
a dead slot with `__yo_ptr_write`, and ends the buffered values in `drop` with
`drop_in_place`, each with a `SAFETY` comment stating why the slot is live or
dead. No copy is made, so no share needs cancelling, and the behaviour at a
copyable or reference-counted `T` is unchanged.

## Test

`tests/thread.test.yo`, "move-only results and channel values": a
`Thread(_ThOnceTok).join()`, a `Channel(_ThOnceTok)` through
`send`/`try_send`/`recv`/`try_recv`/a rejected send/drop with values still
buffered, and a `Sender`/`Receiver` pair across a thread, each counting the
`Drop` runs so every value is dropped exactly once.

## Not covered

`Thread(String)` stays E0602 today: `String` is not `Send` until V2b
(`plans/VALUES_BY_DEFAULT.md`); once it is, the same path carries it.
