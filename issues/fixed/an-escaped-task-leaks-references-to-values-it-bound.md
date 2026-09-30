# An escaped async task leaks references to values it bound, and its thrown error

**Severity:** S2 — every unwound (escaped) task leaks the RC values its locals and awaits held, and the `dyn` error its handler received

**Status:** FIXED (2026-09-30). Re-measured on develop `29bf728b4`: the thrown `dyn` no longer
leaks, but the two `Thing`s still did, with or without an escape. That remaining leak was not
escape-related. An argument's dup temp was dropped through a task slot nothing wrote:
`issues/fixed/an-argument-dup-temp-in-an-io-async-body-is-dropped-through-an-unassigned-slot.md`.
After that fix the repro prints `rc0=2 rc1=2` and valgrind reports 0 errors.
**Found:** 2026-09-29, while fixing
`issues/fixed/an-escape-after-a-closed-branch-re-drops-its-value-enum-locals.md` (#996).

## Measured

`issues/repros/an-escaped-task-leaks-references-to-values-it-bound.yo`: `main` makes two `Thing`s
and keeps them in `keep`. A spawned task loops over them, and each iteration does four things:
- awaits a future that wraps the `Thing` in a value enum;
- binds the enum through `Option.Some` and `unwrap`;
- awaits a `yield`;
- on the second iteration, throws to an unwinding handler.

After the block that spawned and awaited the task has ended:

| Compiler | Output (expected `rc0=1 rc1=1`) | `leaks --atExit` |
| --- | --- | --- |
| #996 (the double-drop fix) | `disposed=0 rc0=3 rc1=3` | both `Thing`s (32 B, from `main`), plus 96 B for the thrown `dyn(\`stop\`)` and its String |
| `b6b828772` (#989) | `disposed=0 rc0=3 rc1=2` (the double drop of #996's fix, one release of `Thing(1)` too many) | — |

Two references per `Thing` are never released, on the value-enum path that the escape sweep and
the scope-end drops share. The handler `err -> unwind(())` never drops the `err` it was given.

## Next step

Count the `Thing` retains and releases in the emitted C of the task and of `make`: the `keep(i)`
index result passed to `make`, `make`'s result as copied into `fresh`, the `Some(fresh)` temp
(its `temp_dup_enum` retain), `unwrap`, and the match binding `t`. Then find the retain whose
release is on none of the paths an escape takes.
