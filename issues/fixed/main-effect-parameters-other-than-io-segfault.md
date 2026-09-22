# `main` with an effect parameter other than `io : Io` segfaults at first use

**Status: FIXED** (surfaced while reproducing the safe-mode Phase 0a repro;
`docs/en-US/DESIGN.md`'s entry-point contract is tightened to match).

## The behavior (measured 2026-09-22, seed v0.2.38)

`DESIGN.md` said `main` "may take effect parameters ... only the result type
is constrained". That over-promised: the C wrapper zero-initializes every
`main` parameter (`_main_call_args` in `src/codegen/functions/generation.yo`
emits `(T){0}`), and only the `Io` record's members are name-dispatched
builtins. Any other effect record — e.g. the documented-shaped
`main :: (fn(io : Io, exn : Exception) -> unit)` — carries NULL function
pointers:

```
$ yo compile escape_sync.yo -o escape_sync.bin && ./escape_sync.bin
[no output]
Segmentation fault (core dumped)
```

The first `exn.throw(...)` calls the NULL `throw` field. (Output was also
lost to stdout buffering — the segv killed the process before the flush.)

## Root cause

`_main_call_args` is fully generic: `(TYPE){0}` for every parameter. That is
correct for `io : Io` (its `await`/`async`/`spawn`/`state` members are
classified as io-builtin METHODS by name — `struct_name == "Io"` in
`src/evaluator/calls/function.yo` — and dispatch to the runtime directly,
never through the record's field pointers) and is a deferred crash for every
other evidence record, whose ONLY members are handler function pointers.

The evaluator accepted any parameter list: the entry-point signature
validation (`_reject_non_unit_main`, `src/module_manager.yo`) checked the
RESULT type only.

## The fix

`_reject_non_unit_main` (the entry-module signature gate both `check` and
`compile` evaluate through) now also walks the parameter types: every
parameter must be the nominal `Io` struct (name match, not source-namespace —
the same nominal-name rule the io-builtin classification uses). Anything else
is a compile error:

```
"main" accepts at most an `io : Io` parameter, but this one takes
struct throw : ctl(generic(ResumeType : Type), error : AnyError) -> ResumeType.
The runtime can only provide the Io record; ...
```

Docs updated (`DESIGN.md` en+zh): the entry-point contract is "at most
`io : Io`".

## Tests

`tests/cli-cases/main-non-io-effect-param-rejected/` — a fixture whose `main`
takes an `Exception` parameter must fail to compile with the new message.
