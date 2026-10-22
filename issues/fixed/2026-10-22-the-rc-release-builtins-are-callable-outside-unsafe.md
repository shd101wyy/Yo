# The RC-release builtins are callable outside `unsafe`

**Severity:** S2 — safe code can release a live field's reference with `__yo_decr_rc(h.xs)` and keep reading the field, which is a heap use-after-free with no `unsafe` and no `pragma(Pragma.AllowUnsafe)` anywhere in the program.

Found 2026-10-22 while gating `___drop`
(`issues/fixed/2026-10-21-the-drop-builtin-is-callable-outside-unsafe.md`): the
builtins that destroy their argument in place are dispatched by the callee's
spelling like `___drop`, and none of them had a gate either.

## Reproducer

`issues/repros/2026-10-22-the-rc-release-builtins-are-callable-outside-unsafe.yo`:

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

Holder :: struct(xs : ArrayList(i32));

main :: (fn() -> unit)({
  mut(h) := Holder(xs : ArrayList(i32).new());
  h.xs.push(i32(1));
  __yo_decr_rc(h.xs);
  println(h.xs.len());
});
export(main);
```

- `yo check` accepts it (tree binary at `188db9ff8`, which already gates `___drop`).
- `yo compile … --optimize 2 --sanitize address --allocator system` and running it reports `ERROR: AddressSanitizer: heap-use-after-free`.

## Root cause

`evaluate_yo_decr_rc`, `evaluate_yo_decr_rc_atomic`, `evaluate_yo_dyn_vtable_drop`, `evaluate_yo_some_type_drop`, `evaluate_yo_drop_array_element` and `evaluate_yo_drop_tuple_element` (`src/evaluator/builtins/rc_fns.yo`) evaluate their arguments and return `unit` without asking where the call is written. The effect analysis already classifies the six as destroying (`src/evaluator/effects/mutation_summary.yo`), but no safe-mode gate read that. No std or test source calls them: codegen emits the C functions of the same names, and the evaluator synthesizes only `___drop`.

## Fix

The six evaluators call `_require_destroying_builtin_capable`, which applies the gate `___drop` has (`is_destroying_builtin_call_capable` in `src/evaluator/memory_safety.yo`: the call is written in an unsafe-capable file) and raises the shared diagnostic `'<builtin>(...)' is not available in safe code`.

The other `__yo_*` RC builtins (`__yo_incr_rc`, `__yo_incr_rc_atomic`, the `dup` forms, `__yo_rc_own`, `__yo_capture_field`, `__yo_gc_collect`) do not destroy a place in place and stay ungated here. `__yo_rc_forget_payload` is declared in `std/prelude.yo` as a runtime extern, so safe code calling it is already rejected by rule D6 ("Calling the runtime extern '__yo_rc_forget_payload' is not available in safe code"). A probe of `___dup(h.xs)` in safe code leaks the buffer (LeakSanitizer, 48 bytes) and does not corrupt memory.

## Test

`tests/safe_code_structural_gates.test.yo`: `__yo_decr_rc(h.xs)` and `__yo_decr_rc_atomic(h.xs)` on a field, `__yo_drop_array_element` on an array of strings, `__yo_drop_tuple_element` on a tuple, `__yo_dyn_drop` on a `dyn` local and `__yo_sometype_drop` on a field are `comptime_expect_error(..., "'<builtin>(...)' is not available in safe code")` cases. Before the fix each block is accepted, so the test fails.
