# Module-level runtime globals bypass `Send`, so safe code can data-race

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** OPEN. **Thread-safety design gap**: `docs/en-US/THREAD_SAFETY.md` says sharing
unsynchronized state across threads is a compile error; this program is green.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
{ ArrayList } :: import("std/collections/array_list");
g := ArrayList(i32).new();
fill :: (fn() -> unit)({
  (i : i32) = 0;
  while(runtime(i < 2000000), {
    g.push(i);
    i = (i + i32(1));
  });
});
main :: (fn() -> unit)({
  t := Thread(unit).spawn((io) => { fill(); });
  fill();
  t.join();
  h := g;
  println(`len=${h.len()} (expected 4000000)`);
});
export(main);
```

`check` and `compile` succeed; the binary fails the ArrayList contract
`ensures failed: (self.len)() == old(...)+1` or dies with SIGTRAP.

## Mechanism (READ)

The `Send`/`Acyclic` check at a spawn is capture-only (`validate_capture_trait_requirements`,
`src/evaluator/utils/closure.yo` ~211). A module-level global is not a capture; it is reached
through `fill`. The row in `plans/archive/THREAD_SAFETY.md` claiming user code cannot declare
mutable statics is therefore false for `:=` module bindings.

## Fix direction

Pick one: (a) require every module-level runtime binding to be `Send + Sync`-safe (atomic,
`Mutex`, or immutable), or (b) make module-level runtime bindings thread-local by default, or
(c) compute the globals transitively reachable from a spawned closure and require `Send` on them.
(a) is the simplest sound rule. Record the decision in `plans/reference/`.
