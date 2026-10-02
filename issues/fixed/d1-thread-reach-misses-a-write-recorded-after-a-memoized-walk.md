# Rule D1's mutable-static check misses a write that lands between a memoized walk and the thread closure that reaches it

**Severity:** S2 — an invalid program is accepted by `check` and `compile`: a spawned closure reads a module global that `main` writes (a data race) when the function it reads through was walked before the write

**Status:** FIXED 2026-10-01 on `fix/check-foreign-bodies`. Found while making `check` summarize
each module's function bodies at module end
(`issues/fixed/check-cannot-see-function-bodies-from-other-modules.md`), which walks every function
before any later module's writes. Regression tests:
`tests/cli-cases/check-send-closure-reads-a-global-written-after-an-earlier-walk-rejected`
(rc=0 before with the develop-built compiler, rejected after with "reads the module-level global
'counter' (at main.yo:4:31), which is assigned at main.yo:13:3").

## Symptom (measured with the compiler built from develop `5567a7796`, and the v0.2.47 seed)

```rust
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
(counter : i32) = i32(0);
read_counter :: (fn() -> i32)(counter);
run :: (fn(k : Impl(Fn() -> i32)) -> i32)(k());
main :: (fn() -> unit)({
  _a := run(() => read_counter());
  bump();
  t := Thread(i32).spawn((io : Io) => read_counter());
  println(`seen=${t.join()}`);
});
bump :: (fn() -> unit)({
  counter = (counter + i32(1));
});
export(main);
```

`yo check` → rc=0; `yo compile --optimize 2` → rc=0, prints `seen=1`. Without the `run(...)` line
both reject the spawn ("… references the module-level global 'counter' (type i32), which is
assigned at …").

## Root cause

D1's mutable-static half (`plans/reference/PARALLELISM_RULES.md`): a `Send` global that is both
written and read by another thread is a data race. The two sites consult each other — a write
checks `g_d1_reached`, and the reach walk checks `g_d1_written` as it reads (`_gr_atom`) — so either
order is caught. But the walk's result is memoized by func id: `run`'s closure is walked where it
is created, before `bump`'s body (forced at its call) records the write, so `read_counter` is
memoized clean. The spawned closure gets the memo, `d1_note_thread_reach` publishes `counter` as
thread-reached — after the write, which therefore never sees it.

## Fix

`d1_note_thread_reach` (which publishes a thread closure's reads, transitively over the recorded
call graph) now also checks each read against `g_d1_written` and returns the violation; its three
callers (`src/evaluator/utils/closure.yo` ×2, `src/evaluator/values/dyn.yo`) report it when the walk
itself found nothing. The order of the write site and the thread closure no longer matters on
either side, memo or not.
