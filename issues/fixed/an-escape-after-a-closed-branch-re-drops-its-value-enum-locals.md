# An escape after a closed branch re-drops the branch's value-enum locals

**Severity:** S1 — an async task that escapes (unwinds) after a branch that bound an RC-carrying value enum, Option or String releases those values twice: heap corruption, a crash in `malloc`

**Status:** FIXED 2026-09-29 (#996, `fix/seed-safe-join-handle`).
**Found:** #996's local battery. `tests/http/http.test.yo` "an unreadable Content-Length is a typed
HttpError, not a silent absence" crashed (exit 11; under Guard Malloc the first bad access is a
`__yo_decr_rc` in the fetch task's `_state_dispose_locals`). The flaky `http_limits.test.yo`
"with_timeout drives a too-short deadline" aborts a fetch task too, and is the same state-machine
path. Both failures were present on develop from #989 (`b6b828772`), but develop's CI could not
show them: #989's battery ran only 173 of 292 test files (the read_dir bug, #992), and from #991
on, stage 1 did not build.

## Measured

Reproducer (the shape of `fetch`'s retry loop):

```rust
_sm_escape_after_branch :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    (i : i32) = i32(0);
    while(runtime(i < i32(3)), {
      (opt : Option(_SmWrap)) = Option(_SmWrap).None;         // _SmWrap :: enum(A(t : Thing), …)
      cond(opt.is_none() => {
        fresh := e.io.await(_sm_make(i, e.io), e);
        opt = Option(_SmWrap).Some(fresh);
      }, true => ());
      w := opt.unwrap();
      e.io.await(yield(e.io), e.io);
      cond((i == i32(1)) => { e.exn.throw(dyn(`stop`)); }, true => ());
      i = (i + i32(1));
    });
    i
  })
);
```

Spawned with an unwinding handler and awaited, 8 runs under Guard Malloc each:

| Compiler | Crashed |
| --- | --- |
| `yo-dev`, before #989 | 0/8 (but the escaped task's locals leaked: 1 of 2 Things disposed) |
| `b6b828772` (#989) | 8/8 |
| #996 before this fix | 8/8 |

## Root cause

A state machine's dispose sweeps every cross-boundary local when the body escaped (`state ==
-2`), because it cannot know which scopes had already closed. #989 widened that sweep to value
enums, Options and Strings, which it had leaked before
(`issues/fixed/abort-dispose-never-drops-string-option-and-value-struct-locals.md`). An earlier
fix for the same class (`issues/fixed/async-scope-end-drop-then-escape-double-drop.md`) makes the
inline scope-end drop clear the field right after it, but only when
`context.in_async_state_machine` is set. That flag is set around some of the generators that emit
a state machine's code, not all of them. The drop at the end of a `cond` branch's remaining code
(`fresh`, and the save-old-value temp of `opt`) ran without it, so the field kept its value and
the escape sweep released it again.

## Fix

`generate_drop` (`src/codegen/exprs/rc_fns.yo`) clears the field whenever the drop target is a
state-machine field (`sm->var_…`, which names nothing else), whichever generator emits it.

## Test

`tests/async/sm_protocol.test.yo`, "an escape after a closed branch drops each value-enum local
once": both `Thing`s must be disposed exactly once. Before the fix the count is wrong and Guard
Malloc crashes; the http test above is the production shape.
