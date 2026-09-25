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

Option (c) of the fix direction, for both halves (option (a) was tried first and rejected the
compiler's own tree — a dozen non-pragma'd `src/` files hold `ArrayList`/`HashMap` state, and
six hold assigned `bool`/`usize` flags — and every single-threaded program with a global cache).
In a file without the pragma, a module-level runtime binding obeys:

1. **Reachability.** Both closure-creation sites call `validate_send_closure_global_reach`
   (`src/evaluator/utils/closure.yo`; separate from the capture check because a capture-free
   closure has no capture struct). A closure bound to a `Send` closure type is walked with
   `function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`): every atom
   that resolves to a module-level, non-`thread_local`, non-`Send` global is a violation, and
   every statically resolved callee is walked in turn (memoized, cycle-safe; a body in a
   pragma'd file is the audited base). The message names the chain: `calls 'fill', which
   references the module-level global 'g' (type ArrayList(i32)), which is not Send …`. Calls
   through closure values and dyn methods are not followed — the residual
   `issues/d1-reach-walk-does-not-follow-closure-values-or-dyn-calls.md`.
2. **`static mut`.** A VALUE-typed (`Send`) global that is written — assigned, the root of a
   field/index store, or bound to an `inout` parameter of a callee that may write through it
   (the D3 mutation-mask decision) — may not also be reached by a `Send` closure. The write sites
   (`_d1_record_write` in `src/evaluator/exprs/assignment.yo`) and the walk record into two
   registries keyed by the global's declaration token and each consults the other, so the error
   lands on whichever site is evaluated second and names the other.

The diagnostics name the alternatives: `thread_local(name)`, an atomic object, or a constant.
Tests: `tests/cli-cases/check-spawn-reaches-non-send-global-rejected` (this issue's repro),
`check-global-assignment-rejected`, `check-global-inout-write-rejected`, and in
`tests/parallelism_soundness.test.yo` a `comptime_expect_error` for the reach rule plus canaries
(a spawned closure calling a function that reads a constant and bumps an atomic; the non-Send
global still usable on the main thread; a `thread_local` written per thread), and a
`comptime_expect_error` for a spawned closure reading a written value global with its canary (a
value global written and read on the main thread only).
