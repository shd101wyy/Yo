# An `Rc(RefCell(Node))` cycle is never tracked by the collector

**Severity:** S1 — the shape decision 46 names for a mutable cycle
(`plans/VALUES_BY_DEFAULT.md` §4 decision 46, `REFERENCES_AND_ORIGINS.md`
O9: "mutable cycles stay `Rc(RefCell(Node))` with the runtime check,
immutable cycles plain `Rc` plus the cycle collector") is never registered
with the cycle collector, so every such cycle a program builds leaks for the
life of the process, like
`issues/fixed/2026-10-20-a-ref-enum-cycle-through-a-ref-struct-is-never-collected.md`.

**Status:** open. **Found:** 2026-10-21 with the v0.2.67 seed, as the
control for `issues/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.md`.

## Reproducer

`issues/repros/2026-10-21-an-rc-refcell-cycle-is-never-tracked-by-the-collector.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio.yo");
{ RefCell } :: import("std/sync/refcell");
Gc :: import("std/gc");
Node :: struct(id : i32, peer : Option(Rc(RefCell(Self))));
form_cycle :: (fn() -> unit)({
  a := rc(RefCell(Node).new(Node(id : i32(1), peer : .None)));
  b := a;
  a.with_mut(v => {
    v.peer = .Some(b);
  });
});
main :: (fn() -> unit)({
  before := Gc.tracked_count();
  form_cycle();
  mid := Gc.tracked_count();
  Gc.collect();
  after := Gc.tracked_count();
  unsafe(printf("before=%lu mid=%lu after=%lu\n", before, mid, after));
});
export(main);
```

Compiled with `--optimize 2` it prints `before=0 mid=0 after=0`: the `Rc`
cell holding the `RefCell(Node)` is never tracked, so `Gc.collect()` has
nothing to reclaim. Under `--sanitize address --allocator system`,
LeakSanitizer reports 56 bytes leaked in 2 allocations. Adding an unrelated
`Dummy :: ref(struct(next : Option(Self)))` and constructing one, which
forces the cyclic runtime on (`compute_needs_cycle_gc`), prints
`before=1 mid=1 after=1`: the runtime is on and the `Rc` cell is still not
registered, so the miss is in the cell's own registration, not only in the
runtime selection.

The same program with `Node :: ref(struct(...))` and a direct `Self` edge is
`tests/cycle_collector.test.yo`'s shape and is collected.

## Root cause (hypothesis)

The prelude's `Rc(V)` is `ref(struct((*) : V))`, a generic reference struct.
`compute_needs_cycle_gc` (`src/codegen/codegen_c.yo`) skips any reference
struct with a generic field (`_struct_has_generic_field`) when it looks for
cycle roots, so a program whose only cells are `Rc` instantiations never
selects the cyclic runtime; and the constructor-side decision
(`src/codegen/functions/constructors.yo`, `registers_with_gc :=
needs_cycle_gc && !is_atomic && can_type_form_rc_cycle(type)`) does not
fire for the `rc(...)` instantiation either (the forced-runtime experiment
above). Under VBD the only non-atomic cell left is this `Rc`, so the walk
that was written for user `ref(struct)` roots covers none of the cells the
language keeps.

## Expected

An `Rc(T)` whose `T` reaches an `Rc` (through `RefCell`, `Box`, a value
struct, a buffer) is tracked, so `Gc.tracked_count()` counts it and
`Gc.collect()` reclaims the unreachable cycle: `before=0 mid=1 after=0`
and no LeakSanitizer report. The narrowing §3.12 plans after decision 46
("reaches a `RefCell`/`Mutex`/`RwLock` whose payload reaches an `Rc`") is a
refinement of this predicate, not a substitute for registering the cell.

## Test

The reproducer's shape as a `tests/cycle_collector.test.yo` case (tracked
count 1 before `Gc.collect()`, 0 after), and a
`tests/codegen-bootstrap/rc_refcell_self_cycle.yo` row beside
`arraylist_self_cycle.yo`.
