# A closure parameter captured by an inner closure is E0901 when the argument closure is move-only

**Severity:** S2 — `spawn_blocking` (std/thread) rejects every move-only closure, and `tests/spawn_blocking.test.yo` fails to compile on develop.

**Status:** open. Found 2026-10-15 while gating `feat/vbd-v3-async-a5`; the
same failure reproduces on develop `fceb684a1` with develop's own tree-built
compiler, so it is not A5's.

## Symptom

```yo
{ spawn_blocking } :: import("std/thread");
{ AtomicI32, MemoryOrder } :: import("std/sync/atomic");
main :: (fn(io : Io) -> unit)({
  progress := AtomicI32(i32(0));
  observed := io.await(spawn_blocking(() => progress.load(MemoryOrder.Acquire), io), io);
  _x := observed;
});
export(main);
```

```text
error[E0901]: use of moved value: the closure captures `cb`, whose type `Impl(Fn() -> T : (Send + Acyclic) + Send)` is move-only (it is neither `Copy` nor `Clone`), so the capture moves it, and `cb` cannot be moved: it is borrowed (a by-value parameter, a `match`/`for` binding, a `&mut` borrow or a module-level binding). Take it `sink(...)` to own it.
```

`spawn_blocking` takes `sink(cb) : Impl(Fn() -> T, Send)` and its
`Thread(unit).spawn((tio : Io) => { … cb() … })` closure captures `cb`. The
parameter is `sink`, so the capture may move it; the message even suggests the
spelling it already has.

- v0.2.62 (the seed) and the `integ-v0262` build accept the program.
- A develop build at `4d942f533` and one at `fceb684a1` reject it. The window
  is v0.2.62..`23787451b`; the likeliest change is #1366 ("closures Copy/Clone
  follow Rust: Copy iff every by-value capture is Copy"), which made a closure
  over an `AtomicI32` move-only and so sends `cb` down the move path. Not
  bisected further.
- develop CI's run on `960a3904c` (shard 2/4, Linux) reported the file passing,
  so the rejection may also depend on evaluation order or platform.

The same class hit `std/async/waker.yo`'s `park`, whose `io.async` body
captured its `register : &Impl(Fn(w : Waker) -> unit)` parameter implicitly; A5
now borrows it explicitly (`io.async({ &register }(io : Io) => …)`).

## Reproduce

`yo test tests/spawn_blocking.test.yo --parallel 1` with a develop-built
compiler: 5 of 5 fail ("the batch failed to compile").
