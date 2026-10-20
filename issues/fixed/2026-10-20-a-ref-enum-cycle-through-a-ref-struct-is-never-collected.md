# A ref-enum cycle through a ref struct is never collected

**Severity:** S1 — a `ref(enum)` whose only edge back to itself runs through a
reference struct (`Kids(k : ArrayList(Self))`) is never registered with the
cycle collector, so every such cycle a program builds leaks for the life of
the process; and the type also read `Acyclic`, so `Iso(T)` accepted it.

**Status:** FIXED 2026-10-20 on `docs/cycle-walk-holder-asymmetry` (`d31c21c57`, see "Fix"). **Found:** 2026-10-20, while checking the cycle walk's
holder asymmetry reported by the `Acyclic` work on
`perf/acyclic-compiler-containers`. The holder side of the same walk is
`issues/2026-10-20-iso-sends-collector-tracked-objects-to-another-thread.md`.
Measured with the v0.2.66 seed. The walk in `src/types/utils.yo` is unchanged
between `v0.2.66` and develop `7def2203b` (the only diff in that file is
`resolve_cell_chain`).

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio.yo");
{ ArrayList } :: import("std/collections/array_list");
Gc :: import("std/gc");
LE :: ref(enum(Nil, Kids(k : ArrayList(Self))));
LS :: ref(struct(k : ArrayList(Self)));
make_le :: (fn() -> unit)({
  k := ArrayList(LE).new();
  e := LE.Kids(k);
  k.push(e); // e -> k -> e
});
make_ls :: (fn() -> unit)({
  k := ArrayList(LS).new();
  s := LS(k);
  k.push(s); // s -> k -> s
});
main :: (fn() -> unit)({
  (mut(i) : i32) = i32(0);
  while(i < i32(1000), i = (i + i32(1)), make_ls());
  Gc.collect();
  unsafe(printf("struct: tracked after collect=%d\n", i32(Gc.tracked_count())));
  (mut(j) : i32) = i32(0);
  while(j < i32(1000), j = (j + i32(1)), make_le());
  Gc.collect();
  unsafe(printf("enum: tracked after collect=%d\n", i32(Gc.tracked_count())));
});
export(main);
```

```
struct: tracked after collect=0
enum: tracked after collect=1000
```

The struct cycle is reclaimed. Every enum cycle stays: the 1000 lists remain
tracked and live, and so do their nodes. The leak grows with the number of
cycles. LeakSanitizer reports nothing, because the collector's tracked list
still points at each list.

The same holds when the struct is a user generic
(`Holder :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(slot : Option(T))))`,
`ME :: ref(enum(Nil, Hold(h : Holder(Self))))`): one tracked object stays per
cycle.

## What the walk answers

| Query (seed v0.2.66)              | Answer  |
| --------------------------------- | ------- |
| `Type.can_form_rc_cycle(LE)`      | `false` |
| `Type.can_form_rc_cycle(LS)`      | `true`  |
| `Type.impls(LE, Acyclic)`         | `true`  |
| `Type.impls(LS, Acyclic)`         | `false` |
| `Type.impls(Iso(LE), Acyclic)`    | `true`  |
| `Type.impls(Iso(LS), Acyclic)`    | `false` |

In the emitted C, `LE.Kids`'s constructor has no `__yo_gc_register(obj)`,
while `ArrayList(LE)`'s constructor has one.

## Cause

`can_type_form_rc_cycle` (`src/types/utils.yo`) walks a reference enum root
with its own id already in `visited`:

```yo ignore
is_reference_enum_type(ty) => match(
  ty,
  Rc(.EnumT({ id : eid, variant_fields : vfs })) => {
    visited := ArrayList(String).new();
    visited.push(eid);
    ...
```

`_type_refs_back_to_cyclic` re-roots at every reference struct it meets:
it replaces `original_id` with the struct's id. From `LE` the walk goes
`LE → ArrayList(LE)`, re-roots at the list, and follows the buffer element back
to `LE`. There the enum arm checks `eid == original_id`, which is now false
because `original_id` is the list's id. Its visited guard then answers
`false`, because `LE` was seeded:

```yo ignore
Rc(.EnumT({ id : eid, variant_fields : vfs })) => cond(
  (eid == original_id) => true,
  _id_already_visited(visited, &eid) => false,
  ...
```

The struct arm answers `true` for a visited reference struct, so `LS` is
found. The enum root is the only caller that pre-seeds the root's id.
`codegen/functions/constructors.yo`'s per-variant registration gate calls
`_type_refs_back_to_cyclic(&ft, enum_id, ArrayList(String).new())` with an
empty `visited`. From there the walk pushes `LE` when it meets it after the
re-root, walks it once, and reaches the list's id again (`true`).

The runtime turns the wrong answer into a leak. `__yo_gc_mark_gray`
(`src/codegen/functions/gc_runtime.yo`) descends only into objects flagged
`__YO_GC_TRACKED`. The list is tracked and the node is not, so trial deletion
never subtracts the node's reference to the list, and the list's count never
reaches zero.

No ref enum in `src/` or `std/` has this shape. `EvalValue`, `AstExpr`,
`VcTerm` and `VcSort` each have a direct `Self` payload, which the
`eid == original_id` check finds before any re-root.

## Fix

Do not seed the root's id in `can_type_form_rc_cycle`'s enum arm. That makes
the root call agree with the per-variant gate. A direct `Self` edge is still
found by `eid == original_id`, which precedes the visited guard. A path that
re-roots and comes back pushes the enum once and walks it, so it terminates
the same way.

Measured with the tree binary built from `d31c21c57` (the fix on develop
`7def2203b`):

| Probe                                            | Seed v0.2.66 | Fixed   |
| ------------------------------------------------ | ------------ | ------- |
| 1000 `LE` cycles, tracked after `Gc.collect()`   | 1000         | 0       |
| one `ME` / `Holder(ME)` cycle, tracked after collect | 1        | 0       |
| `Type.can_form_rc_cycle(LE)`                     | `false`      | `true`  |
| `Type.impls(LE, Acyclic)`                        | `true`       | `false` |
| `Type.impls(Iso(LE), Acyclic)`                   | `true`       | `false` |
| `Type.can_form_rc_cycle(HX)` (holder of `X`)     | `false`      | `false` |
| `Type.can_form_rc_cycle(HY)` (holder of `Y`)     | `true`       | `true`  |

The holder rows do not change. The fix touches only an enum ROOT that the
walk meets again after a re-root. A holder's answer is the other defect,
`issues/2026-10-20-iso-sends-collector-tracked-objects-to-another-thread.md`.

The compiler's own C does not change. The only reference enums in `src/` and
`std/` are `EvalValue`, `AstExpr`, `VcTerm` and `VcSort`. Each has a direct
`Self` payload, so the walk already answered `true` for them before the fix.

## Test

`tests/cycle_collector.test.yo`, "A ref-enum cycle closed through its
ArrayList(Self) is collected". It builds one `KNode.Kids(k)` / `k.push(e)`
cycle, collects, and asserts that the node was disposed, that the tracked
count is back to its base, that `Type.can_form_rc_cycle(KNode)` holds, and
that `KNode` is not `Acyclic`. With the seed the first assertion fails ("the
node of the list-closed cycle was disposed").
