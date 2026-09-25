# A `ctl` handler stored in a `ref(struct)` field escapes its frame; a later call exits `main` with rc=0

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** FIXED 2026-09-25 (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 5.5). Was an effects-typing hole: control flow silently skipped the rest of `main`.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Raise :: (ctl(msg : String) -> i32);
Slot :: ref(struct(r : Raise));
dummy :: (fn(msg : String) -> i32)(i32(1));
install :: (fn(s : Slot) -> i32)({
  (raise : Raise) = ((msg) -> { unwind(i32(7)); });
  s.r = raise;
  i32(0)
});
main :: (fn() -> unit)({
  s := Slot(r : dummy);
  println(`install returned ${install(s)}`);
  println(`calling escaped handler`);
  v := s.r(`boom`);
  println(`late: ${v}`);
  println(`still alive`);
});
export(main);
```

`check` and `compile` green. After `install` returns, `s.r("boom")` unwinds through a frame that
no longer exists; the program exits rc=0 without printing `late:` or `still alive`.

## What holds (MEASURED)

A closure capturing a ctl value is rejected, `ArrayList(Raise)` is rejected, and a generic
closure returning `T = Raise` is rejected. `ArrayList` and `Box` are caught only because their
internals hold a `*(T)`, and the pointer-pointee check (`src/evaluator/calls/pointer.yo` ~107)
rejects control-bound pointees. A `ref(struct)` field has no such pointer, so nothing fires.

## Fix direction

At type definition, run `type_is_control_bound` on every field type of a `ref(...)`/`atomic(...)`
struct or enum and reject control-bound fields, instead of relying on the pointer check as a side
effect. The e4 message also renders the ctl type as `fn(msg : String) -> i32`; print it as `ctl`.
Related: `issues/module-level-control-bound-binding-not-rejected.md`.

## Resolution (2026-09-25, Phase 5.5)

A `ref(...)`/`atomic(...)` struct or enum rejects a control-bound field at its definition:
`type_is_control_bound` on each field type, in `src/evaluator/types/struct.yo` and `enum.yo`,
with the message from `control_bound_field_message`. The type printer now renders a `ctl`
function type as `ctl(...)`.

Test: `tests/cli-cases/ctl-handler-in-a-ref-struct-field-is-rejected`.
