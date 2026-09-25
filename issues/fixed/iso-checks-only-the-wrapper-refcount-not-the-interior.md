# `Iso(T)` checks only the wrapper's refcount, so an aliased interior crosses threads

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 2, rule D2). Was: OPEN. **Thread-safety design gap**.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
{ ArrayList } :: import("std/collections/array_list");
Wrap :: ref(struct(items : ArrayList(i32)));
fill :: (fn(xs : ArrayList(i32)) -> unit)({
  (i : i32) = 0;
  while(runtime(i < 2000000), {
    xs.push(i);
    i = (i + i32(1));
  });
});
main :: (fn() -> unit)({
  shared := ArrayList(i32).new();
  w := Wrap(items : shared);
  iso := Iso(Wrap)(w);
  t := Thread(unit).spawn((io) => {
    inner := iso.extract();
    fill(inner.items);
  });
  fill(shared);
  t.join();
  println(`len=${shared.len()} (expected 4000000)`);
});
export(main);
```

Green `check` and `compile`; the run fails the same ArrayList contract or traps, because both
threads push to one list.

## Mechanism (READ)

`Iso` is "unconditionally Send" per the SAFETY comment in `std/prelude.yo` (~9466). Extraction
checks that the wrapper's own refcount is 1; nothing checks that the interior is uniquely owned.
`docs/en-US/ISOLATED.md` still describes the older TypeScript-era model.

## Fix direction

Require a deep-uniqueness proof at `Iso(T)(v)`: either restrict `T` to types whose interior is
`Send` (so aliasing is harmless), or walk the value at construction and require refcount 1 on
every reachable ref. Rewrite ISOLATED.md to the chosen rule.

## Fix (2026-09-26, rule D2)

`^v` now walks the whole graph at runtime: `__yo_iso_unique_<Iso>(v)`
(`generate_iso_uniqueness_functions`, `src/codegen/functions/constructors.yo`) visits `v` and
every non-atomic object reachable from it and fails on the first whose `ref_count != 1`; an
atomic object stops the walk (shared by design). It descends through the per-type traversal
functions the cycle collector uses — whose visitor now receives each child's own traverse
function as a second argument (`__yo_traverse_atomic_stop` marks an atomic child, NULL an unknown
one, which fails) — so it needs no header state and works in a program without the cycle
collector; traversal functions and container `Trace` methods are emitted whenever the program uses
`Iso`. An explicit thread-local worklist keeps a long list from recursing; no visited set is
needed, because reaching an object twice already means its count is at least 2. The `^` macro
calls it through the `__yo_iso_unique` builtin, which reads its argument in place.

Test: `tests/iso.test.yo` "^ answers .None when an object inside the value is shared" — this
issue's shape (`Wrap(items : shared)`).
