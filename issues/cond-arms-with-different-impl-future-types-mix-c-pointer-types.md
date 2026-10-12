# `if` arms returning futures of different concrete types mix C pointer types

**Severity:** S2 — a valid program fails in the C compiler
(`incompatible pointer types assigning to '..._state_t *' from '..._sync_fut_t *'`).

Found while writing the regression tests for the §3.13 A2 review
(2026-10-13). It predates A2 and involves no borrow: the released seed
v0.2.59 fails the same way.

## Reproducer

```yo
{ yield } :: import("std/async");
{ println } :: import("std/fmt");
quick :: (fn(k : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => (k * i32(10)))
);
later :: (fn(k : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    k * i32(10)
  })
);
main :: (fn(io : Io) -> unit)({
  b := true;
  n := io.await(if(b, later(i32(2), io), quick(i32(2), io)), io);
  println(&n);
});
export(main);
```

```text
error: incompatible pointer types assigning to '_file____User_temp_71198369190761756701_state_t *'
from '_file____User_temp_176789355127225725091_sync_fut_t *' [-Werror,-Wincompatible-pointer-types]
```

## Root cause (suspected)

Both arms have the type `Impl(Future(i32, Io))`, so the evaluator accepts
the `cond`. In C, though, `later`'s body awaits and lowers to a state
machine (`..._state_t *`), while `quick`'s body does not and lowers to the
synchronous future (`..._sync_fut_t *`). The `cond` result slot takes the
first arm's C type, and the second arm is assigned into it unconverted.
Either the two arms must share one erased representation, or the evaluator
must reject arms whose `Impl(Future)` resolutions differ (an opaque type
names ONE concrete type, as in Rust, where `if b { a() } else { b() }` over
two `impl Future`s is a type error).

## Workaround

Await in each arm (`if(b, io.await(later(...), io), io.await(quick(...), io))`),
or make both arms call the same function.
