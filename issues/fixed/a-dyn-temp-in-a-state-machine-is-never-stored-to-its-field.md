# A `dyn` temp in a state machine is never stored to its field (the thrown error leaks)

**Severity:** S2 — a `dyn(...)` value built after an await in an `io.async` body leaks; the common case is every error a task throws to an unwinding handler

**Status:** FIXED 2026-09-29 (branch `fix/sm-dup-temp-leak`, after the release).
**Found:** 2026-09-29, verifying
`issues/fixed/a-dup-result-temp-in-a-state-machine-is-released-through-an-empty-field.md`: with that
fix, `leaks --atExit` on its reproducer still showed 96 B (the thrown `dyn(\`stop\`)`, its String
box and bytes).

## Measured

```rust
work :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    e.io.await(yield(e.io), e.io);
    e.exn.throw(dyn(`stop`));
    i32(1)
  })
);
// main: spawn it with `Exception(throw : (err -> unwind(())))`, await it in a block.
```

| Compiler | `leaks --atExit` |
| --- | --- |
| `yo-dev` (before #989) | 4 leaks, 176 B |
| #996 | 3 leaks, 96 B (the error) |
| the emitted C with the field store added by hand | 0 leaks |

The same throw from a synchronous function to the same handler leaks nothing, so the handler does
drop the error it is given.

## Root cause (read in the emitted C)

`generate_dyn_call` (`src/codegen/exprs/dyn.yo`) declares the fat-pointer temp as a C local:

```c
__yo_t_Dyn_Error _file____User_temp_…901 = { .data = …, .vtable = &… };
… exn.throw(_file____User_temp_…901) …
if (__yo_effect_escaped) { sm->state = -2; … return; }      // escape: the sweep releases the FIELD
__yo_dyn_release(sm->var__file____User_temp_…901_….data, …);  // completion: releases the FIELD
```

The state machine hoists the temp, so both releases name its `sm->var_…` field, which nothing
assigned. The release on the zeroed field did nothing and the error leaked. The declaration's comment
said "SM-field routing is Phase 5, gated dead here". Every other temp declaration site stores into the
field through `_store_temp_var_to_state_machine_if_needed`; this one never did.

## Fix

`generate_dyn_call` stores the temp into its state-machine field after declaring it, through
`_store_temp_var_to_state_machine_if_needed` (a no-op outside a state machine and for a temp that is
not hoisted).

## Test

`tests/async/sm_protocol.test.yo`, "an error a task throws after an await is released": the thrown
error is a `ref` struct whose `Dispose` counts. #996's binary disposes it 0 times and the test fails;
with the fix it is disposed once.
