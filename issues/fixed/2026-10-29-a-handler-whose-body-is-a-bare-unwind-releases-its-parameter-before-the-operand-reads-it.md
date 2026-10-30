# A handler whose body is a bare `unwind(...)` releases its parameter before the operand reads it

**Severity:** S1. `exn := Exception(throw : (e -> unwind(e.to_string())))`,
the most common way to catch an error, reads the caught error after it has
been freed (ASan: heap-use-after-free). The trap shape
`e -> unwind(Option(AnyError).Some(e))` releases the error and then stores
it, so the trapped error is a dangling `Dyn`. A compiler whose own traps
take this shape crashes (SIGSEGV) at the first trapped evaluation error.

**Found:** 2026-10-29, in B13-b (errors by value, `vbd/b13b-errors-by-value`).
B13-b made `Exception.throw` and `ResumableException(T).throw` pass the error
by value, so a handler owns its parameter and drops it. The code path is
older: before B13-b a handler parameter was a borrow with nothing to drop, so
nothing reached it. Any by-value handler parameter of an owning type has the
bug.

## Reproducer

`issues/repros/2026-10-29-a-handler-whose-body-is-a-bare-unwind-releases-its-parameter-before-the-operand-reads-it.yo`,
built with `yo compile <file> --std-path ./std --sanitize address --allocator system`:

```yo
{ Exception, AnyError } :: import("std/error");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
fail :: (fn(exn : Exception) -> i32)(exn.throw(dyn(String.from("a fairly long error message to allocate"))));
run :: (fn() -> String)({
  exn := Exception(throw : (e -> unwind(e.to_string())));
  _x := fail(exn);
  String.from("no")
});
main :: (fn() -> unit)({
  println(run());
});
export(main);
```

```text
==…==ERROR: AddressSanitizer: heap-use-after-free on address …
```

The emitted handler releases `e` on entry:

```c
static inline void* fn_yo_id_…(__yo_t_… __yo_v_e) {
  __yo_dyn_release((void*)(__yo_v_e).data, (const void*)(__yo_v_e).vtable);
  __yo_t_… _t = (__yo_v_e).vtable->__yo_v_to_string((__yo_v_e).data);
  …
```

A block body (`e -> { s := e.to_string(); unwind(s) }`) and a `fn` whose
whole body reads its parameter (`(fn(e : AnyError) -> String)(e.to_string())`)
are both clean.

## Analysis

A bare-expression body shares its node id with the begin block the evaluator
wraps around it, so its own-parameter scope-end drops sit on the tail
expression's node. `generate_implicit_return_statement`
(`src/codegen/exprs/return.yo`) had this branch for a control-flow tail:

```yo ignore
if(ast_expr_is_fn_call_of(expr, BF_UNWIND, Option(usize).None), {
  generate_deferred_drop_expressions(expr, indent.clone(), context, false, true);
});
code := _call_generate_expr(expr, indent.clone(), context);
```

It flushed those parameter drops before it generated the `unwind`, and so
before the operand that reads the parameter. (`generate_unwind`'s own
pending-drop flush skips a drop on the unwind's own node, by the pending
path's contract.)

## Resolution

Fixed 2026-10-29 in B13-b. `generate_implicit_return_statement` now records
the tail's id in `FunctionGenerationContext.unwind_tail_param_drops_id`
instead of flushing. `generate_unwind` emits those drops in its drop
preamble (`_emit_unwind_tail_param_drops`): after the operand is evaluated
into its temp, and covered by `_reraise_escape_after_drops`. A lowering that
does not reach `generate_unwind` gets the drops right after the tail is
generated. The compiler's own three traps (`helper.yo`, `function.yo`,
`values/impl.yo`) are written as block bodies, because the v0.2.72 seed that
builds them still has the bug. Test: `tests/algebraic_effects.test.yo`, "an
unwind operand reads a handler local and the handler's error before they are
released", covering the `to_string` and trap shapes under ASan.
