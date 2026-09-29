# A dup-result temp in a state machine is released through an empty field (a leak per call)

**Severity:** S2 — in a state machine, every call that takes a retained RC argument (an index result, a field read) leaks one reference, whether or not the task escapes

**Status:** FIXED 2026-09-29 (branch `fix/sm-dup-temp-leak`, after the release).
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

| Compiler | Output (expected `rc0=2 rc1=2`) | `leaks --atExit` |
| --- | --- | --- |
| #996 (the double-drop fix) | `disposed=0 rc0=3 rc1=3` | both `Thing`s (32 B, from `main`), plus 96 B for the thrown `dyn(\`stop\`)` and its String |
| `b6b828772` (#989) | `disposed=0 rc0=3 rc1=2` (the double drop of #996's fix, one release of `Thing(1)` too many) | — |
| this fix | `disposed=0 rc0=2 rc1=2` | 96 B: the thrown error, a separate bug (below) |

The expected value is 2, not 1: `keep` holds one reference and the pushed temporary holds the other
until `main`'s scope ends. The same program without the spawn block prints `rc0=2 rc1=2`. (This
document first said 1, and so counted two leaked references per `Thing`; there is one.)

The remaining 96 B is the thrown error, a different temp with the same kind of defect:
`issues/fixed/a-dyn-temp-in-a-state-machine-is-never-stored-to-its-field.md`. The first
guess, that the handler `err -> unwind(())` never drops its `err`, was wrong: a synchronous
throw to the same handler leaks nothing.

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
the `Thing`s are pushed in their own block, so after the task and its block only `keep` and the
test's own binding hold `Thing(5)` and `rc` is 2. #996's binary gives 3 (the test fails there); the fix gives 2.
