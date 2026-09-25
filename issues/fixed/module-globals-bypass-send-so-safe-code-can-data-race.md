# Module-level runtime globals bypass `Send`, so safe code can data-race

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 5).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 3, rule D1 of `plans/reference/PARALLELISM_RULES.md`). Was: **Thread-safety design gap**: `docs/en-US/THREAD_SAFETY.md` says sharing
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

## Fix (2026-09-26, rule D1)

Option (c) of the fix direction, plus a `static mut` rule (option (a) was tried first and
rejected the compiler's own tree — a dozen non-pragma'd `src/` files hold `ArrayList`/`HashMap`
state — and every single-threaded program with a global cache): in a file without the pragma that is not a test file
(`*.test.yo` and the runner's batch files are exempt, like the class-1 panic ban), a module-level
runtime binding

1. **Reachability.** At the spawn-boundary capture check (`validate_capture_trait_requirements`,
   now handed the closure's id and evaluated body), a closure bound to a `Send` closure type is
   walked with `function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`):
   every atom that resolves to a module-level, non-`thread_local`, non-`Send` global is a
   violation, and every resolvable callee is walked in turn (memoized, cycle-safe; a callee that
   cannot be resolved — a dyn method — is a violation; a body in a pragma'd file is the audited
   base). The message names the chain: `calls 'fill', which references the module-level global
   'g' (type ArrayList(i32)), which is not Send …`.
2. **`static mut`.** A VALUE-typed global (the kind another thread may read) may not be
   assigned, be the root of a field/index store, or be bound to an `inout` parameter of a callee
   that may write through it — the same mutation-mask decision as D3
   (`throw_if_write_through_atomic_root` / `d3_record_inout_place` grew a module-global branch,
   `_module_global_root_type`). `*.test.yo` files are exempt from this one (dispose counters).

The diagnostics name the alternatives: `thread_local(name)`, an atomic object, or a constant.
Tests: `tests/cli-cases/check-spawn-reaches-non-send-global-rejected` (this issue's repro),
`check-global-assignment-rejected`, `check-global-inout-write-rejected`, and in
`tests/parallelism_soundness.test.yo` a `comptime_expect_error` for the reach rule plus canaries
(a spawned closure calling a function that reads a constant and bumps an atomic; the non-Send
global still usable on the main thread; a `thread_local` written per thread).
