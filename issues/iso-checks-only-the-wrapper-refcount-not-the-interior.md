# `Iso(T)` checks only the wrapper's refcount, so an aliased interior crosses threads

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** OPEN. **Thread-safety design gap**.
**Measured:** yo 0.2.39 seed.

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
