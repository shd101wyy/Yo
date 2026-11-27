# A handler record built inline in the call is not an installation

**Severity:** S2 — passing `Eff(raise : raise, log : log)` straight into the call, in the frame that bound `raise`, does not install the handler: its `unwind` passes the installer and the process aborts with "unhandled effect unwind escaped to top level". Binding the record to a local first works.

- Filed: 2026-11-28, finding F4 of VERDICTS-94 (Fable 5.2, §8), with its probes `p08`, `p08c` (fail) and `p08b` (works).
- Status: open. Closed by K-1 of [`plans/backlog/CAPABILITIES_AND_HANDLERS.md`](../plans/backlog/CAPABILITIES_AND_HANDLERS.md) (v0.2.82).
- Related: the same root as `issues/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind.md` (F1).

## Reproducer

`issues/repros/2026-11-28-a-handler-record-built-inline-in-the-call-is-not-an-installation.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : &String) -> i32);
Log :: (ctl(msg : &String) -> unit);
Eff :: struct(raise : Raise, log : Log);

run :: (
  fn(
    generic(T : Type, E : Type.Struct),
    f : (fn(e : E) -> T),
    e : E
  ) -> T
)(f(e));

might_fail :: (fn(e : Eff) -> i32)({
  e.log(`about to fail`);
  e.raise(`boom`)
});

go :: (fn() -> i32)({
  (raise : Raise) = (msg -> unwind(i32(-1)));
  (log : Log) = (
    msg -> {
      println(msg);
      return(());
    }
  );
  might_fail(Eff(raise : raise, log : log))
});

main :: (fn() -> unit)({
  println(`go=${go()}`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. Compiled with `--optimize 2 --sanitize address --allocator system`, rc 134:

```text
about to fail
unhandled effect unwind escaped to top level
```

Expected: `about to fail`, then `go=-1`. The same abort happens through the generic `run(might_fail, Eff(raise : raise, log : log))` (VERDICTS-94 `p08`). With the record bound first, `effects := Eff(raise : raise, log : log); run(might_fail, effects)`, the program prints `go=-1` (`p08b`).

## Root cause

As VERDICTS-94 §8 states it: `_call_is_handler_installation` (`src/codegen/exprs/other-fn-call.yo`, line 1811 on `c1f2221be`) decides from syntax whether a call installs a handler, and it tests only arguments that are atoms (a local naming a handler or a record of them). A struct construction in argument position is not an atom, so `go`'s call is emitted as a propagation site, `go` re-raises the unwind and nothing above catches it. The install site is guessed from syntax, as in F1.

## Fix

K-1: the frame catches by identity (`__yo_unwind_target` against the frame's own handler literals), so where the record is built no longer matters, and `_call_is_handler_installation` is deleted.

## Test

None in this filing: the bug is open with no fix. The test lands with K-1: this repro and the `run(...)` form as run-time tests that print `go=-1`.
