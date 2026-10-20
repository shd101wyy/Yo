# An effect binder bound only through a future parameter resolves to Io

**Severity:** S2: a generic function whose effect binder `E` appears only in its future parameter (`fut : Impl(Future(T, E))`) gets `E = Io` whatever the operand's bundle is. Awaiting or spawning an `IoExn` operand with the `io.async` body's bundle `(e : E)` is then rejected with "Effect argument does not match the future's effect bundle … The argument's type: Io". The workaround is to take the bundle as a plain parameter too (`e0 : E`), which binds `E` correctly. Because of this, `std/async`'s `timeout` and `select` take only `Io` futures, and `std/http` keeps a private copy of the deadline race for its `IoExn` exchange.

**Status:** OPEN (triaged). **Found:** 2026-10-20, while rebasing VBD §3.13 A4's std half (`feat/vbd-a4-std-half`). `plans/VALUES_BY_DEFAULT.md` §3.13 A4 says an effect-generic `timeout` "hit the same binder family"; this doc is the reproduction of that remark. It fails the same way with the v0.2.66 seed, with develop `fc15a6092`'s tree-built compiler, and with the A4 branches' compilers.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
{ Exception, IoExn } :: import("std/error");
import("std/async");
wrap_e :: (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), io : Io) -> Impl(Future(T, E)))(
  io.async({ fut, io }(e : E) => io.await(fut, e))
);
_mk_i32 :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async((e : IoExn) => i32(7))
);
main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (_err -> { unwind(()); }));
  e := IoExn(io : io, exn : exn);
  a := io.await(wrap_e(_mk_i32(io), io), e);
  assert(a == i32(7), "a");
  println("ok");
});
export(main);
```

```text
error: Effect argument does not match the future's effect bundle:
- The future's effect type: IoExn
- The argument's type      : Io
   --> tmp/egv2.yo:6:48
   |
 6 |   io.async({ fut, io }(e : E) => io.await(fut, e))
   |                                                ^
```

Measured variants, each with ONE call (so this is not a two-instantiation collision), on develop `fc15a6092`:

| shape | result |
| --- | --- |
| the reproducer (`E : Type.Struct`, `io.await(fut, e)`) | rejected, `e` is `Io` |
| `E : Type` instead of `E : Type.Struct` | rejected, the same message |
| `e.io.await(fut, e)` (no captured `io`) | rejected, the same message |
| the `timeout` shape: `(h : JoinHandle(T)) = io.spawn(fut, e)`, then join | rejected, the same message at the spawn |
| the reproducer plus a plain parameter `e0 : E`, called with the bundle | compiles and runs (`ok`) |
| the `timeout` shape plus `e0 : E` | compiles and runs (`ok`) |
| `E` spelled `IoExn` everywhere (no effect binder) | compiles and runs (`ok`) |

`tests/async/combinators.test.yo`'s `_a4_id_exn` ("an effect-binder operand resolves through the future parameter") passes only because it also takes `e : E`.

So `T` resolves through the future parameter (`issues/fixed/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md`), but the future's EFFECT slot does not bind `E`: with no other parameter mentioning it, `E` ends up as `Io`.

## Direction

Find where a call binds a generic function's binders from an `Impl(Future(R, E))` argument (the same path that binds `R` from the operand's future type) and bind `E` from the operand's effect type as well. The fix's regression test is the table above: the three rejected shapes must compile and run, and the `e0 : E` controls must keep working.

Once it is fixed, `timeout` and `select` in `std/async/index.yo` can be generic over the operand's effect type, and `std/http/client.yo`'s `_deadline_join` can pass the exchange's future to `timeout` instead of racing a handle. Until then the `e0 : E` parameter is a working, if redundant, spelling for an effect-generic combinator.
