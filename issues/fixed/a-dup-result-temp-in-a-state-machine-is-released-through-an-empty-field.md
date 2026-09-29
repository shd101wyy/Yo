# A dup-result temp in a state machine is released through an empty field (a leak per call)

**Severity:** S2 — every unwound (escaped) task leaks the RC values its locals and awaits held, and the `dyn` error its handler received

**Status:** FIXED 2026-09-29 (branch `fix/sm-dup-temp-leak`, after the release; build verification pending).
**Filed as:** `issues/an-escaped-task-leaks-references-to-values-it-bound.md`. The leak turned out not to be specific to escaped tasks.
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

## Root cause (measured: an RC trace of the reproducer's emitted C)

A retain/release trace of the first `Thing` has 7 retains against 7 releases. One retain is
unmatched: the `keep(i)` index result, retained into a temp and passed to `make(...)`. In the C:

```c
__yo_t_Thing* _file____User_temp_1377… = __yo_incr_rc(<keep(i)>);          // a C LOCAL
… = make(_file____User_temp_1377…, sm->__yo_param_0.io);
__yo_decr_rc(sm->var__file____User_temp_1377…_4332…);                      // the HOISTED FIELD: never assigned, NULL
```

The deferred-dup emitter (`generate_deferred_dup_expressions`, `src/codegen/exprs/drop_dup.yo`)
declare-assigns a synthesized dup's result temp as a C local. The state machine hoists that temp,
though, so the call's post-call release resolves it to its `sm->var_…` field. Every other temp
declaration site in a state machine also stores the temp into its field
(`_store_temp_var_to_state_machine_if_needed`); this one did not. The release was a no-op on the
zeroed field, and every such call leaked one reference.

## Fix

`generate_deferred_dup_expressions` stores a declare-assigned result temp into its state-machine
field, like every other temp declaration site. The helper moved from `other_fn_call.yo` into
`drop_dup.yo`, which `other_fn_call.yo` already imports, so drop_dup can call it.

## Test

`tests/async/sm_protocol.test.yo`, "an index result passed to an async call in a task is released":
after the task and its block, only `keep` and the test's own binding hold the `Thing`, so `rc` is 2.
Before the fix it is 4. `tmp/idx_leak.yo` in this worktree is the same shape as a program.
