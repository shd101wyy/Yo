# A runtime-position `Type.get_info` emits the comptime-only `TypeInfo` struct into C

**Severity:** S2. Every program that ran a borrowed `for` on the B8 tree emitted 21 `// Unknown type:` markers: the C struct of the comptime-only `TypeInfo`, with its `FunctionInfo` and `TraitKind`. The compiler's own self-emit was one of those programs, so the bootstrap fixpoint's stage-2 hollow gate failed (`STAGE2_HOLLOW_GATE_FAILED`, 21 real markers). The C still compiled, because each marker is a comment in an unused struct.

Found 2026-11-03 by B8's pre-PR fixpoint (`fixpoint_only.sh`, S1 = `yo-tree-ae0436771`). The same failure showed up in the draft chain PR #1735's "Bootstrap fixpoint (yo-self self-compile)" job.

## Reproducer

```yo
main :: (fn() -> unit)({
  x := i32(1);
  y := cond(match(Type.get_info(i32), .Struct(_, _) => true, _ => false) => i32(2), true => x);
  { println } :: import("std/fmt");
  println(&y);
});
export(main);
```

`yo compile repro.yo --emit-c --skip-c-compiler` writes `struct … { // TypeInfo : TypeInfo` with 21 `// Unknown type: Type __yo_v_element;`-style members. The develop compiler (`ce827ae52`) does the same: the bug is older than B8.

Every one of these spellings shows it:
- a `::` binding of `Type.get_info(C)` inside a runtime generic body;
- a comptime helper fn that returns `bool` from a `match` on it.

B8 made it universal. `__borrow_guard` (`std/prelude.yo`) is a runtime generic fn behind every borrowed `for`, and it chooses handle-or-nothing with `cond(match(Type.get_info(C), …) => …)`.

## Root cause

`_collect_types_from_node` (`src/codegen/types/collection.yo`) collects the `ExprInfo` type of every node it walks. That includes nodes the evaluator folded at compile time, here the `Type.get_info(C)` call, whose type is `TypeInfo`.

`collect_type` then registered `TypeInfo` as a C struct and recursed into its variant fields, `FunctionInfo` and `TraitKind`. Each of their fields is `Type` or `ComptimeList(…)`, which have no C form and lower to the `// Unknown type:` comment.

## Fix

`collect_type` skips a nominal record with a comptime-only runtime field (`_has_comptime_only_runtime_field`). That means a struct's non-`comptime` field, or an enum variant's payload, whose type is `Type`, `ComptimeList`, `comptime_int`, `Expr` and so on (`type_is_comptime_only`).

Such a type has no C representation. It reaches collection only through a compile-time-folded expression, which emits no code, so collecting nothing is the right lowering. A source-namespace struct (a module) is exempt; its comptime members are filtered by its field flags.

## Test

`tests/internal/codegen_param_slots.test.yo`, "a record with a comptime-only field has no C form; a runtime record does": a `FunctionInfo`-shaped record with a `Type` field has no C form, and an `i32`/`bool` record does.

The fixpoint's stage-2 hollow gate is the end-to-end check: 0 real markers with this fix.
