# A downcast result used as a method receiver is never released

**Severity:** S2 — `downcast(d, T).is_some()` (any method called directly on a `downcast` result) leaks the reference the downcast took on the payload, once per evaluation; a check in a loop grows without bound.

**Found:** 2026-10-16, the last leak verdicts of the family in `issues/fixed/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md`, after the async classes were fixed. `tests/dyn.test.yo` with leak verdicts on fails "Test downcast type check via is_some" and "Test downcast to a value type that no dyn() in the program wraps" (72 bytes in 3 allocations each) and "Dyn: upcast drops traits and keeps each payload's impls" (24 bytes). All three call `.is_some()`/`.is_none()` on a `downcast(...)` directly. Reproduces on develop `b0c4630d3` (`fix/async-capture-leaks`'s build too: nothing there touches it).

## Reproducer

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt");
Cat :: ref(struct(n : i32));
impl(Cat, ToString(to_string : (self -> `cat`)));
main :: (fn() -> unit)({
  (animal : Dyn(ToString)) = dyn(Cat(n : i32(1)));
  assert(downcast(animal, Cat).is_some(), "a cat");
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r`: `SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s)` (the `Cat`). Binding the result first (`d := downcast(animal, Cat); assert(d.is_some(), …)`) does not leak: the local's scope-end drop releases it.

## Root cause

The evaluator does give both results an owning temp: `evaluate_downcast` and `evaluate_upcast` (`src/evaluator/builtins/downcast.yo`) call `attach_temp_variable_to_expr(expr, true, ctx)`, and the enclosing scope schedules that temp's drop. The emitters never declared it. `generate_downcast` and `generate_upcast` (`src/codegen/exprs/downcast.yo`) returned the bare C expression (`(check) ? __yo_dyn_retain(...) : NULL`), and `generate_deferred_drop_expressions` silently skips a `___drop` whose target is not in `declared_c_var_names` (the guard documented in `c-codegen.instructions.md`, "A hand-written C declaration must be registered").

Every other producer of an owning temp declares its own: a call (`other_fn_call.yo`), a tuple, an array, `dyn()`, `match` and `cond`. Consumers rely on that. Three consumers happen to re-declare an operand that is not already its temp: a binding (`d := downcast(...)`), a by-value argument (`_materialize_arg`), and `&` (`peek(&downcast(...))`). That is why only the other positions leaked:

| position | before |
| --- | --- |
| `downcast(d, T).is_some()` (a `&self` receiver; also inside a `cond` condition or an `&&`) | leaked |
| `upcast(d, Dyn(Tr)).to_string()` | leaked |
| `downcast(d, T);` / `upcast(d, Dyn(Tr));` as a statement | leaked |
| `x := downcast(d, T)`, `f(&downcast(d, T))`, `match(downcast(d, T), ...)` | clean |

Probed on develop `b0c4630d3` under ASan. The same positions are clean for a call result (`mk().is_some()`, `mk();`), a constructor, an `Array(T, N)(...)` ctor, an anonymous struct, a tuple, and a `cond`/`match`/block yielding a downcast. So the defect is in the producer. Going through every `attach_temp_variable_to_expr(expr, true, …)` site and its emitter found one more producer of the same shape: `generate_iso_type_call`, the `Iso(T)(v)` constructor (`src/codegen/exprs/iso.yo`, owning temp from `evaluate_iso_value_call`). It returned a bare `__yo_create_iso_<T>(v)`. As a receiver, `Iso(Rc(i32))(x).extract()` leaked 24 bytes; discarded, `Iso(Rc(i32))(x);` leaked 36 bytes in 2 allocations; bound to a local first, it is clean. The constructor is pragma-only (`Pragma.AllowUnsafe`); safe code builds an Iso with `^v`, which passes it straight to `.Some(...)`.

## Fix

`bind_owning_result_temp` (`src/codegen/exprs/other_fn_call.yo`) is now called by `generate_downcast`, `generate_upcast` and `generate_iso_type_call`. It declares the attached temp (`get_variable_type_string`, which records the name in `declared_c_var_names`), stores it to its state-machine slot inside an `io.async` body (`_store_temp_var_to_state_machine_if_needed`), and returns the temp's name, the way `generate_dyn_call` and `generate_anonymous_tuple` do. The scheduled scope-end drop now finds its target. The three re-declaring consumers see their operand already named and declare nothing more.

Regression test: `tests/dyn.test.yo` "Dyn: a downcast or upcast used as a receiver or discarded releases its payload". It uses a `Drop` counter on a `ref` payload, so it fails with leak verdicts off. `tests/iso.test.yo` "an Iso constructor used as a receiver or discarded releases its value" does the same for the Iso constructor. `tests/async/sm_ownership.test.yo` "a downcast receiver inside io.async releases its reference" covers the state-machine slot store, with downcasts before, between and after awaits. The three tests listed above now pass with leak verdicts on.
