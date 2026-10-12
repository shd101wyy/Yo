# A capture's move flag is read in a state machine that has none

**Severity:** S2 — a valid program whose `io.async` capture list names a value that another state machine captures implicitly under the same name fails in the C compiler (`no member named '__yo_mv___capture_…'`)

**Status:** FIXED 2026-10-12 (feat/vbd-v3-genb, §3.13 A3 Generation B).

## Symptom

Found while making `std/async`'s `join` and `timeout` own their handle through
a capture list (`io.async({ self }(io : Io) => …)`,
`io.async({ handle, ms }(io : Io) => …)`). Any program that used both failed
to compile its C:

```text
error: no member named '__yo_mv___capture___yo_v_ms' in 'struct …_state_t_struct'
   if (!sm->__yo_mv___capture___yo_v_ms) {
error: no member named '__yo_mv___capture___yo_v_self' in 'struct …_state_t_struct'
 sm->__yo_mv___capture___yo_v_self = 1;  // moved out: the slot's value is its new owner's
```

The minimal shape is one state machine that owns a capture list naming `ms`
and a second one, nested in it, that captures `ms` implicitly:

```yo
ms := Rc(u64)(u64(5));
outer := io.async({ ms }(io : Io) => {
  inner := io.async((io : Io) => {
    io.await(sleep(ms.*), io);
    ()
  });
  io.await(inner, io);
  ()
});
io.await(outer, io);
```

## Cause

A state machine that owns its capture list (an `FnOnce` capture struct,
decision 37) declares a move flag per counted capture,
`uint8_t __yo_mv___capture_<label>`, and records `__capture.<label>` in one
global set (`note_sm_move_flag_field`, `src/codegen/async/state_machine_naming.yo`).
`sm_move_flag_of` answered from that set alone. Local slots are safe there,
because their field names carry the variable id, but a capture field is named
by its label only. So once any state machine had declared the flag for
`ms`, every other state machine with a capture named `ms` read and wrote a
flag its own struct never declared: the abort dispose's inline capture drops
(`_emit_inline_capture_field_drops`) and the move site of a capture
(`atom.yo`).

## Fix

`sm_move_flag_of` takes whether the current state machine owns its capture
list, and answers `.None` for a `__capture.` field otherwise. The move and
store sites pass `sm_owns_fnonce_captures(context)`; the dispose passes
`is_fnonce_capture_struct` of the capture struct it drops. A state machine
that does not own its captures takes the existing path: a move out of a
capture empties the slot.

Regression test: `tests/async/join_handle.test.yo`, "a capture list and a
nested implicit capture of the same name compile", and every `std/async`
combinator test (`join` and `timeout` take both shapes).
