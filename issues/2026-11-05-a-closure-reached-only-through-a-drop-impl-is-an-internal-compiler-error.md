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

## Root cause (not yet located)

The closure's implementation function is registered for emission only when its enclosing
function is reached through the ordinary call walk. A `Drop` impl's `drop` is emitted on
demand from the drop-glue path, after (or outside) that walk, so a closure first reached
from it was never collected, and the emitter's lookup of its implementation fails. The
fix belongs where drop functions are emitted on demand: whatever drives the walk for
ordinary functions must also run for the drop body and its callees.

## Workaround

Keep closures out of the drop path. `tests/short_circuit_drops.test.yo` bumps its
`RefCell(i32)` counter with `replace` (no closure): `old := c.replace(i32(0)); c.replace(old + i32(1));`.

## Test

The fix adds the reproducer's shape as a test case (a `Drop` body that calls
`RefCell.replace_with`, plus a helper reached only from a drop) and moves this doc to
`issues/fixed/`. It also restores the natural spelling in
`tests/short_circuit_drops.test.yo`: `Tracked`'s `drop` writes
`self.c.n.replace_with(n => (n.* + i32(1)));` in place of the two-`replace` workaround
(the comment there names this doc), so no workaround stays behind.
