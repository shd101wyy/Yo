# A by-value capture-list entry of an RC value never retains it

**Severity:** S1 — a valid program corrupts memory: the capture field aliases the
source handle without `__yo_incr_rc`, the closure's scope-end drop releases the
cell under the still-live binding, and the binding's own drop then touches
freed memory.

Status: FIXED 2026-10-07 — `_evaluate_capture_list`
(`src/evaluator/values/anonymous_function.yo`) now emits the DUP expression as
a by-value entry's field initializer, exactly as the ordinary implicit-capture
path does (`generate_captured_variable_dup_expressions`): an atom initializer
of an RC-typed binding builds and evaluates `___dup(<name>)`; a non-owning
temp's already-recorded dup is picked up from the initializer's ExprInfo.
Owning temps keep their move (the temp is consumed), and a move-only atom read
keeps its loud E0901 move. Tests: tests/closure_capture_list.test.yo
("a by-value capture of an RC value retains it").

Found 2026-10-07 by the round-1 self-audit of `feat/vbd-capture-lists` (the
review's own findings were lost in transit; this was found by running the
review's stated lens, "leaked or un-dropped values in new code paths").

## Reproducer

```rust
{ println } :: import("std/fmt");
(g_disposed : i32) = i32(0);
Tr :: ref(struct(v : i32));
impl(Tr, Dispose(dispose : (fn(self : Self) -> unit)({ g_disposed = (g_disposed + i32(1)); })));
main :: (fn() -> unit)({
  t := Tr(v : i32(7));
  {
    (f : Impl(Fn() -> i32)) = ({ t }() => t.v);
    println(f());
  };
  println(t.v);   // reads freed storage
});
export(main);
```

The program hangs at exit (the allocator walks corrupted free-list state); with
stdout buffered, nothing prints. The same defect hits every ATOM-initializer
by-value entry of an RC-bearing type — `{ t }`, `{ x : t }`, a `String` pun
`{ s }` — while an owning call result (`{ n : make_tr(5) }`) is moved
correctly and non-RC entries need no refcount.

## Root cause

The emitted capture-struct initializer copies the source handle with no
retain:

```c
__yo_t_…capture __yo_v_f = (__yo_t_…){ .__yo_v_t = __yo_v_t };   // no __yo_incr_rc
…
__yo_decr_rc((void*)((__yo_v_f).__yo_v_t));   // block end: rc 1 → 0, dispose + free
…
__yo_decr_rc((void*)(__yo_v_t));              // main end: freed memory
```

`_evaluate_capture_list` called `set_expr_as_needs_to_call_dup(ev_val, …,
"field-store")`, but that helper no-ops for an initializer with no temp
`variable_name` — a plain atom read is exactly that — and for a non-owning
temp it records the dup on the INITIALIZER's ExprInfo, which the capture
field's codegen (`expr_info_capture_field_inits` in
`src/codegen/exprs/closures.yo`) never reads. The capture-list path also
skipped `generate_captured_variable_dup_expressions`, the channel that dups
every RC-typed capture for an ordinary implicit closure.

## Fix

A by-value entry of an RC-bearing, implicitly-copyable type now carries the
dup expression itself as its initializer: for an atom read it is
`___dup(<name>)` built and evaluated at the literal (the same three lines
`generate_captured_variable_dup_expressions` uses), and for a recorded
non-owning-temp dup it is that recorded expression. `generate_dup` lowers it
inline (`__yo_incr_rc(...)`) in the field initializer, restoring the balance:
the closure's drop releases the capture's own reference.
