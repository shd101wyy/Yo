# A generic `io.async` function's capture move flag leaks across its specializations

**Severity:** S2 — a valid program failed in the C compiler
(`no member named '__yo_mv___capture___yo_v_v'`).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12. The defect
came with A1 (by-value capture lists on `io.async`, commit 7a9b6f373); develop
rejects every `io.async` capture list.

## Symptom

```yo ignore
gen :: (fn(generic(T : Type), x : ArrayList(T), v : T, io : Io) -> Impl(Future(usize, Io)))(
  io.async({ x, v }(io : Io) => {
    io.await(yield(io), io);
    x.push(v);
    x.len()
  })
);
a := io.await(gen(ArrayList(i32).new(), i32(1), io), io);
b := io.await(gen(ArrayList(String).new(), `q`, io), io);
```

```text
error: no member named '__yo_mv___capture___yo_v_v' in 'struct …_state_t_struct'
```

Each specialization alone compiled.

## Root cause

A state machine that owns a capture list declares a move flag beside each
owned field that needs a drop (`__yo_mv___capture_<label>`), and registers the
field in `g_sm_move_flag_fields` (`src/codegen/async/state_machine_naming.yo`)
so moves and the dispose find it. That registry is keyed by field name, and
a capture field's name carries no struct id. The `String` specialization
registered `__capture.__yo_v_v`; the `i32` one declares no flag for `v`
(nothing to drop), but its dispose (`_emit_inline_capture_field_drops`)
found the shared name and tested the flag its struct lacks.

## Fix

`_emit_inline_capture_field_drops` (`src/codegen/exprs/async.yo`) consults
the move flag only for the fields its own capture struct declared one for
(`_owned_capture_fields`), the same predicate the struct emitter uses.

Regression test: `tests/async_await.test.yo`, "a generic io.async body's
capture move flag belongs to its specialization".

The same defect was found independently and fixed on develop by #1325
(`issues/fixed/a-capture-move-flag-is-read-in-a-state-machine-that-has-none.md`).
When this branch was rebased, develop's code was kept. It gates the flag
on `is_fnonce_capture_struct` together with
`type_contains_rc_cell_or_move_only`, the same predicate as
`_owned_capture_fields`. This document's regression test still covers it.
