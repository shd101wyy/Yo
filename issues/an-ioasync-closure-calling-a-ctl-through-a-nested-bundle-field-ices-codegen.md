# An `io.async` closure calling a `ctl` through a nested bundle field ICEs codegen

Status: open
Filed: 2026-09-24 (found during the 2026-09-24 docs code-block audit)
Seed: yo 0.2.41 (`~/.local/lib/yo/v0.2.41`)

## Symptom

`yo check` passes (only an unused-variable warning). `yo compile` — even with
`--skip-c-compiler` — aborts with an internal compiler error:

```
$ yo check repro.yo
warning: unused variable `result`
$ yo compile repro.yo --skip-c-compiler
yo: error: internal compiler error: repro.yo:4:3: this `io.async` closure's body was never fully evaluated — an error inside it was deferred at definition time and never re-checked, so the emitted sync-future future would run nothing and silently complete.
Fix the error inside the body. Common causes: a type error the deferred trial swallowed, a forward reference (move the definition above its use), or a call with a wrong argument count.
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

## Minimal reproducer

`issues/repros/ioasync-nested-ctl-call-ice.yo`:

```rust
{ Exception, IoExn } :: import("std/error");

task_fn :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async((e : IoExn) => {
    e.exn.throw(`boom`);
    return(i32(42));
  })
);

main :: (fn(io : Io) -> unit)({
  swallow := Exception(throw : ((err) -> unwind(())));
  result := io.await(task_fn(io), IoExn(io : io, exn : swallow));
});
export(main);
```

The trigger is `e.exn.throw(...)` — a `ctl` call routed through a NESTED field
of the closure's effect-bundle parameter. All of these variants were measured:

| shape | check | compile |
| --- | --- | --- |
| ctl through nested field (`e.exn.throw`), no await point | OK | ICE |
| same, WITH an await point before the call | OK | ICE |
| inferred closure param (`io.async(e => …)`) instead of annotated | OK | ICE |
| direct ctl field (`ctx.raise(...)` with a custom `Ctx` bundle, handler bound in the same scope) | "Closures cannot capture a value of control-bound type" (clean rejection) | — |
| custom `Ctx` bundle, handler bound in a helper `fn` (tests/async_await.test.yo:1854 "Test JoinHandle await returns None on unwind") | OK | OK |

So the working shapes reject or compile cleanly; only the nested-field ctl
call takes the deferred-error path that is never re-checked at codegen.

## Root cause (analysis)

The evaluator defers full evaluation of an `io.async` closure body at
definition time when the trial evaluation records an error (here presumably
the control-bound capture analysis on `e.exn.throw`). The sync-future /
codegen path then requires that the body was fully evaluated at some point;
since the deferred error was never re-raised and never cleared, `_codegen`
hits the "body was never fully evaluated" assertion and reports it as an ICE
instead of surfacing the deferred diagnostic. The error message itself
documents the intended contract; the bug is that `check` passes while the
body carries a swallowed error — the re-check that would surface it never
runs for this shape.

## Fix direction

Whoever picks this up: find where the deferred trial error for the closure
body is recorded (the control-bound capture analysis of a nested ctl field
call), and either surface it at definition time (making `check` fail, like
the same-scope custom-bundle shape) or re-check the body before the
sync-future emit path asserts. A regression test belongs next to
`tests/async_await.test.yo`'s "Test JoinHandle await returns None on unwind"
(fix + test land together; move this doc to `issues/fixed/` then).
