# A capture in a generic `io.async` body is dropped with another instantiation's type

**Severity:** S2 — a generic function whose `io.async` body owns a move-only capture, instantiated at two types, fails in the C compiler (`passing 'JoinHandle(i32)' to parameter of incompatible type 'JoinHandle(T)'`)

**Status:** FIXED 2026-10-12 (feat/vbd-v3-genb, §3.13 A3 Generation B).

## Symptom

Found while making `std/async`'s `join` own its handle through a capture list
(`join : (fn(self : Self, io : Io) -> …)(io.async({ self }(io : Io) => …))`,
in a `generic(T : Type)` impl). A program that joined handles of two result
types failed to compile its C:

```text
error: passing '__yo_t_3384195354235509809' (aka 'struct __yo_t_3384195354235509809_struct')
  to parameter of incompatible type '__yo_t_13144215613771946301' (aka 'struct __yo_t_13144215613771946301_struct')
  if (!sm->__yo_mv___capture___yo_v_self) {
  yo_id_18348332480609749804000004(sm->__capture.__yo_v_self);
```

The called function is the `Dispose` of `JoinHandle(T)` with `T` unresolved;
the field is a `JoinHandle(i32)`.

## Cause

The state machine's dispose drops an owned capture list field by field
(`_emit_inline_capture_field_drops`, `src/codegen/exprs/async.yo`), and
`_owned_capture_fields` picks the fields to flag. Both read the fields from
the field registry, `get_struct_fields(struct_id)`. A closure's capture struct
id is shared by every evaluation of that closure, so for a closure in a
generic body the registry holds whichever instantiation's field types were
registered first, or the generic ones. The state machine's capture slot is
declared with the instantiated capture type, so the slot and its drop
disagreed.

## Fix

`_capture_struct_fields` takes the labels and effect-parameter flags from the
registry and each field's type from the instantiated capture type itself.
Both the dispose and the move-flag declaration use it.

Regression test: `tests/async/combinators.test.yo` (`join` and the
combinators over `JoinHandle(i32)`, `JoinHandle(unit)` and
`JoinHandle(Rc(i32))` in one binary) and `tests/async/join_handle.test.yo`.
