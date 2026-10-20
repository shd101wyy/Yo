# An io.async bundle parameter typed by an effect binder binds as Io

**Severity:** S2: a generic function over the effect type of its future operand (`fut : Impl(Future(T, E))`) cannot await or spawn that operand inside its own `io.async` body. The closure's bundle parameter `(e : E)` is checked as `Io` even when `E` is `IoExn`, so the evaluator rejects the program with "Effect argument does not match the future's effect bundle". Because of this, `std/async`'s `timeout` and `select` take only `Io` futures, and `std/http` keeps a private copy of the deadline race for its `IoExn` exchange.

**Status:** OPEN (triaged). **Found:** 2026-10-20, while rebasing VBD §3.13 A4's std half (`feat/vbd-a4-std-half`). `plans/VALUES_BY_DEFAULT.md` §3.13 A4 says an effect-generic `timeout` "hit the same binder family"; this doc is the reproduction of that remark. It fails with the v0.2.66 seed and with a tree-built compiler carrying the A4 fixes (`fix/combinator-spec-per-operand-future` plus the std half).

## Reproducer

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
{ Exception, IoExn } :: import("std/error");
import("std/async");
wrap_e :: (fn(generic(T : Type, E : Type), fut : Impl(Future(T, E)), io : Io) -> Impl(Future(T, E)))(
  io.async({ fut }(e : E) => e.io.await(fut, e))
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
   --> tmp/eg5.yo:7:46
   |
 7 |   io.async({ fut }(e : E) => e.io.await(fut, e))
   |                                              ^
```

Measured variants (all with one call, so this is not a two-instantiation collision):

| shape | result |
| --- | --- |
| the reproducer above (`(e : E)`, `e.io.await(fut, e)`) | rejected, `e` is `Io` |
| the same body with `(h : JoinHandle(T)) = e.io.spawn(fut, e)` and a join (the `timeout` shape) | rejected, the same message at the spawn |
| the closure parameter unannotated, `(e) =>` | rejected, the same message |
| `E` spelled `IoExn` everywhere (no effect binder) | compiles and runs (`ok`) |
| no `io.async`: `await_e(generic(T, E), fut : Impl(Future(T, E)), e : E) -> T` awaiting `e.io.await(fut, e)` | compiles and runs |

So the binder `E` itself is inferred (the plain function works); what goes wrong is the bundle type of an `io.async` closure inside a generic function whose result is `Impl(Future(_, E))`: the closure's bundle parameter is bound as `Io`, not as the instantiation's `E`.

## Direction

Find where an `io.async` closure's bundle parameter type is decided (the effect type of the enclosing function's declared `Impl(Future(R, E))` result, or the closure's own annotation) and check whether that read happens on the generic declaration, before `E` is substituted, with `Io` as the fallback. The fix's regression test is the table above: the reproducer, the spawning `timeout` shape, the unannotated form, and the two passing controls.

Once it is fixed, `timeout` and `select` in `std/async/index.yo` can be generic over the operand's effect type, and `std/http/client.yo`'s `_deadline_join` can go back to calling `timeout`.
