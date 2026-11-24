# A generic function's bundle-less `Impl(Future(T))` result hides its body's bundle

**Severity:** S1 — memory unsafety in safe code: a program `yo check` accepts calls through a null handler and segfaults (rc 139).

**Status: FIXED 2026-11-24** by the VERDICTS-68 PR (`v0280/io-v68`). Found by the io-v68 lane while writing the verdict's "generic `R` (`with_lock`)" negative.

## Reproducer

```yo
{ println } :: import("std/fmt");
Tell :: (fn(x : i32) -> i32);
TellCtx :: struct(io : Io, tell : Tell);
g :: (fn(generic(R : Type), x : R, io : Io) -> Impl(Future(i32)))(
  io.async((ctx : TellCtx) => ctx.tell(i32(3)))
);
main :: (fn(io : Io) -> unit)({
  (v : i32) = io.await(g(i32(1), io), io);
  println(&v);
});
export(main);
```

With the v0.2.79 seed: `yo check` passes, the binary exits with rc 139. The non-generic spelling of the same function is rejected (E0604 then, E0605 now), and so is the same future passed to an `Impl(Future(i32))` parameter.

## Root cause

The bundle direction rule (`future_view_drops_a_bundle`,
`issues/fixed/a-bundled-future-viewed-as-future-t-runs-with-a-zeroed-bundle-and-segfaults.md`)
is applied by `are_types_compatible`, the per-call `Impl` parameter check, and the concrete function's
body-versus-result check. A generic function's body is checked against its result at each
instantiation (`_eval_and_check_specialized_body`, `src/evaluator/calls/helper.yo`), and that
check skips any result type that carries a `SomeT` (`sb_skip`). Every `Impl(...)` result is a
`SomeT`, so the instantiated body `Impl(Future(i32, TellCtx))` was never compared with the
declared `Impl(Future(i32))`. The same hole let a `-> Impl(Future(R))` wrapper over
`Mutex.with_lock` (whose future reads an `Io`) drop its bundle.

## Fix

`_eval_and_check_specialized_body` applies `future_view_error` (the E0605 future-view
diagnostic, `src/evaluator/utils.yo`) to every instantiated body before `sb_skip`, where the
generic bundle is concrete.

Regression tests (`tests/async/effect-bundle.test.yo`): "a generic fn's bundle-less future
result cannot hide a handler bundle" and the `_lock_view` case of "an Io-bundled future cannot
be viewed as Future(T)".
