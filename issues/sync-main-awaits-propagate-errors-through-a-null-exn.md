# An IoError propagating to a main-level `io.await` calls a NULL `exn.throw`

**Status: OPEN** (found 2026-09-08 while validating the version-install
cross-device fix; reproduced under gdb).

## Error

A program whose `main :: (fn(io : Io, exn : Exception) -> T)` awaits a
future that completes with an IoError dies with SIGSEGV at PC 0x0:

```
#0  0x0000000000000000 in ?? ()
#1  ... in <create_dir_sm>_resume () at prog.c:16130
16130  (((void* (*)(__yo_t91))sm->__yo_param_0.exn.throw)((__yo_t91)(...)));
```

`sm->__yo_param_0.exn.throw` is NULL.

## Root cause

`_main_call_args` (`src/codegen/functions/generation.yo:984-1010`)
zero-initializes EVERY runtime parameter of `__yo_user_main` —
`main :: (fn(io : Io, exn : Exception) -> T)` is invoked as

```c
__yo_user_main((__yo_t25){0}, (__yo_t26){0});   // io = {0}, exn = {0}
```

(`__yo_main_thread_entry`, the "Call sync main" site). The zeroed `io`
is harmless — the sync-await bridge inlines the wait protocol and
`io.async` uses the runtime's global Io — but the zeroed `exn` is NOT:
the sync-await site builds the awaited future's effect bundle as
`IoExn(io : io, exn : exn)` from those same zeroed params, so every
state machine under the main-level await inherits `exn.throw == NULL`.
The first error thrown through it (e.g. `create_dir` returning -ENOENT)
calls the NULL pointer.

Reproducer (`tmp/fixme.yo` shape — any ENOENT works):

```rust
main :: (fn(io : Io, exn : Exception) -> i32)({
  // Parent /tmp/no-such-parent does not exist → mkdirat = -ENOENT.
  io.await(create_dir(Path.new("/tmp/no-such-parent/child"), io),
           IoExn(io : io, exn : exn));
  i32(0)
});
export(main);
```

Works only if the error is never raised; the moment it is, PC 0x0.

## Fix direction

`_main_call_args` (and `generateMainWrapper`'s evidence-free branch)
should synthesize a REAL handler for the `exn` parameter the way the
runtime does for `io`: either
- emit a default `exn` whose `throw` prints the error and exits
  non-zero (a top-level unhandled-error report), or
- route the bundle's `exn` to the runtime's unhandled-exception path
  (`__yo_effect_escaped` + a diagnostic), matching what `panic` at
  top level does today.

The same audit should check `Io`'s zeroed function pointers for any
remaining direct call-through (currently only the sync-await bridge and
`io.async` touch them, both of which bypass the zeros).

## Notes

- Found from the EXDEV probe: `create_dir` on a missing parent
  (my probe bug) took the error path and crashed — the ENOENT itself was
  correct behavior.
- Related cluster:
  issues/async-closure-value-struct-param-emits-invalid-c-cast.md (same
  state-machine argument plumbing).
