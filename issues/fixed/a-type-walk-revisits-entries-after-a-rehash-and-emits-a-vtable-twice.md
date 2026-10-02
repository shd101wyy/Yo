# A type walk revisits entries after a rehash and emits a vtable twice

**Severity:** S2 — a valid program with `Dyn` values fails to build when its
type count puts a type-table resize inside codegen's declaration walk (C
`redefinition of '__yo_t_<N>_vtable_s'`). Locally this aborted the fast suite
at `tests/dyn.test.yo`, so 223 of 305 files never ran.

**Status:** FIXED. Found 2026-10-02 while gating the v0.2.49 candidates. First
measured on develop `7d04eb24d` by yo-f4 and yo-65.

## Symptom

```
tests/.yo_selftest_batch_82_0.bin.c:1577:16: error: redefinition of '__yo_t_1724568819303928241_vtable_s'
tests/.yo_selftest_batch_82_0.bin.c:1584:16: error: redefinition of '__yo_t_15486517093125380247_vtable_s'
...
yo: error: test: tests/dyn.test.yo — 0 of 31 tests in this batch ran: the batch failed to compile (exit != 0).
```

The duplicates are not two entries for one type. Each repeated
`// Vtable for dyn(...)` has exactly one forward `typedef struct X_vtable_s
X_vtable;` and one fat-pointer struct, and those come from a walk over a key
snapshot (`generate_dyn_forward_declarations`). The second definitions form a
tail after the full list: AsyncRead twice in a row, then
`dyn(ToString + Error)`, `TestDyn`, `_OsGen`, `_OsOt` again. Larger programs
also redefine Future interface bodies (`redefinition of
'__yo_t_<N>_struct'`), which come from the same walk's future-trait arm.

## Root cause

Pass 5 of `generate_type_declarations` (`src/codegen/types/generation.yo`)
emits dyn, union and future-trait declarations by iterating
`context.types.keys()` live. `HashMapKeys` is a bucket index over the map's
current table. `generate_dyn_declaration` resolves each method's C type with
`get_type_string`. A method returning `Impl(Future(T, E))` registers that
Future interface on demand, and that inserts into `context.types` in the middle
of the walk. When an insert crosses the 7/8 load factor, the table doubles and
every entry is re-placed. The walk then continues at its old index in the new
table, meets entries it had already visited, and emits their vtables again.
Pass 4 (nullable-pointer enums) iterates the same way.

Whether it fires depends only on whether a resize lands inside pass 5. Type
keys hash the module path as typed, so layout and count shift with the entry
path (`yo test tests/dyn.test.yo` passed while `cd tests && yo test
dyn.test.yo` failed). It also shifts with every std change: P3c's (#1034)
container constructors moved develop's `dyn.test.yo` batch into the window.

Measured with the v0.2.48 seed: a program with N traits, each `Dyn`-dispatched
through a method returning a distinct `Impl(Future(P_i, IoExn))`, fails for
exactly N = 34–38 and N = 72–84. Those are the counts that put the 224- and
448-entry resize thresholds inside the walk.

## Fix

`_unseen_type_ids(context, seen)` snapshots the type ids not yet in `seen`.
Passes 4 and 5 now walk that snapshot, then take another one, until a
snapshot comes back empty. Each id is visited exactly once, and the types the
walk itself registers are still reached, as the live walk sometimes did.

## Regression test

`tests/cli-cases/dyn-vtables-registering-futures-are-each-defined-once`
compiles two such programs, one in each window (N = 36, N = 78). Before the
fix both fail with the redefinitions (the v0.2.48 seed scores the case
GOLDEN-DIFF, rc=1). After it both compile, and `cd tests && yo test
dyn.test.yo --std-path ../std`, which failed on every run, passes 31/31.
