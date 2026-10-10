# A by-value `self` called through a Dyn frees the payload

**Severity:** S1 — a safe program reads freed memory and aborts: every call through a `Dyn` slot that takes `self` by value drops the payload the `Dyn` still owns.

**Status:** fixed on `feat/vbd-decision42-gen-b` (decision 34 as amended 2026-10-11).

## Symptom

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
S :: struct(name : String);
impl(S, LogicalNot((!) : (fn(self : Self) -> bool)(self.name.len() == usize(0))));
main :: (fn() -> unit)({
  (e : Dyn(LogicalNot)) = dyn(S(name : String.from("abc")));
  println(!e);
  println(!e);
  println(!e);
});
export(main);
```

This should print `false` three times. Instead it printed `false`, `true`, `true`, then aborted with rc=134 (`--optimize 2`, macOS, `MallocScribble=1`). The first call freed `name`, the next two read the freed buffer, and the `Dyn`'s own drop freed it again. With a `Dispose` payload the same shape disposed the value once per call and once more when the `Dyn` died.

The bug predates the 2026-10-11 amendment: any trait slot spelled `self : Self` that is reached through a `Dyn` had it. The amendment made it common, because `LogicalNot`, `Negate` and `BitNot` now take `self` by value and are Dyn-callable (they return `bool` or `Self.Output`, not `Self`).

## Root cause

A by-value parameter is OWNED by the callee (`FuncMeta.param_is_owning`), and the callee drops it at its end. The vtable wrapper (`generate_dyn_wrapper_functions`, `src/codegen/functions/dyn.yo`) passed the boxed payload straight through, `box->field` or `concrete_value`. That handed the impl ownership of a value the `Dyn` box still owned, with no reference-count increment.

## Fix

- **Codegen.** When the impl's first parameter is owning and not passed by pointer, and the payload type holds a counted cell (`type_contains_rc_cell_or_move_only`), the wrapper calls a per-impl `__yo_dyn_self_copy_<impl>` helper. The helper returns `generate_dup_code_for_value(v)`, so the impl gets its own copy with every counted field incremented. Its drop then balances that increment.
- **Evaluator.** A move-only payload (`type_is_move_only`: `Dispose`, `MoveOnly`, a call-once closure, a `mut`-capturing closure) has no copy to hand over. `_require_dyn_traits_implemented` (`src/evaluator/values/dyn.yo`) therefore rejects boxing one into a `Dyn` that has a by-value-`self` slot, with E0614 ("cannot hold the move-only ..."). The other choice, a slot that consumes the `Dyn`, would make it a call-once object, which `Dyn` is not.

## Test

`tests/parameter_modes.test.yo`, "a by-value self called through a Dyn gets a copy of the payload":

- three calls through a `Dyn(LogicalNot)` over a `String`-holding struct;
- a `comptime_expect_error` showing that a `Dispose` payload is rejected.

Before the fix the batch failed to compile on the missing rejection. Without that line, the calls returned the wrong values and the process aborted.
