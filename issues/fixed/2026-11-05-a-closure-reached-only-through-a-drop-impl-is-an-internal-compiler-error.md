# A closure reached only through a `Drop` impl is an internal compiler error (E1301)

**Severity:** S1 — an internal compiler error on valid input: any closure literal in a `Drop` body, or in a function only a `Drop` body calls, stops the compile with E1301.

Found while migrating `tests/short_circuit_drops.test.yo` off `ref(struct)` (V5 part B,
branch `vbd/v5-part-b-tests`), on develop 68b45b81d. The `ref` version wrote its counter
with a plain field assignment; the value version writes a `RefCell` field, and every
`RefCell` writer except `replace` takes a closure.

## Symptom

```
error[E1301]: internal compiler error: Closure implementation function not found in context
This is a bug in the Yo compiler, not in your program — please report it:
```

There is no source location. Reproducer: `issues/repros/2026-11-05-closure-reached-only-from-drop-ice.yo`
(`yo compile <it> --skip-c-compiler`).

```yo ignore
_apply :: (fn(f : &Impl(Fn(x : i32) -> i32)) -> i32)(f(i32(1)));
_bump :: (fn() -> unit)({
  g_n = (g_n + _apply(x => (x + i32(1))));
});
T :: struct(v : i32);
impl(T, Drop(drop : (fn(self : &mut Self) -> unit)({ _bump(); })));
```

Measured variants (all on 68b45b81d):

| Closure lives in | Reached from | Result |
| --- | --- | --- |
| the `Drop` body itself (`self.c.n.replace_with(n => …)`, `_apply(x => …)`) | the drop | E1301 |
| a helper `_bump` | only the drop | E1301 |
| the same helper `_bump` | the drop and `main` | compiles, runs correctly |
| the same helper `_bump` | only `main` | compiles, runs correctly |

## Root cause

Codegen collects what it emits in passes (`src/codegen/codegen_c.yo`): the function walk
from the exports (`collect_required_functions`), then the type walk
(`collect_required_types`), whose fixpoint walks the body of every registered function, and
only then the dispose synthesis (`collect_dispose_methods`). A closure literal's
implementation function is registered by the type walk (`collect_types_from_expr` registers
the `FuncVal` the literal's `ExprInfo` holds, `src/codegen/types/collection.yo`). The dispose
synthesis evaluates each move-only type's `___dispose` (`(Self <: Drop).drop(self)`) and
registers the user `drop`, and the function walk it runs registers every function the `drop`
calls; but none of those functions ever reached the type walk, which had already finished.
A closure built only there was never registered, and emitting the `drop` body (or the helper)
found no implementation function: E1301. A helper also called from `main` was registered and
type-walked before the dispose synthesis ran, which is why that variant compiled.

## Fix

The type walk's fixpoint is `collect_types_of_registered_functions(context, info, processed)`,
which keeps the set of walked functions. `codegen_c` runs it again after the dispose synthesis
over the functions that synthesis registered, then synthesizes the disposes of any types that
walk added, until neither adds a function or a type, and re-runs `collect_pointer_pointees` for
the types added. A `drop` body is now collected like any other function body.

## Test

`tests/closure_reached_only_from_drop.test.yo`: a `Drop` body writing a `RefCell` field through
`replace_with` and through `with_mut`, a helper only a `drop` calls whose `with_mut` closure
writes the cell, and the reproducer's `_apply(x => …)` helper. Each was E1301 before the fix.

`tests/short_circuit_drops.test.yo` still bumps its counter with two `replace` calls on
`vbd/v5-part-b-tests` (the stopgap this doc named); that branch restores
`self.c.n.replace_with(n => (n.* + i32(1)));` once this fix merges.
