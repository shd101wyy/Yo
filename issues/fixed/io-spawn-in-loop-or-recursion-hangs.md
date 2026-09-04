# `io.spawn` inside a loop or a recursive call hangs (spins at 100% CPU)

**Status: FIXED 2026-08-23 — the JoinHandle now owns its future.**

`src/codegen/exprs/generation.yo` (`_generate_io_spawn`) emits an
`__yo_incr_rc` for the future when the spawn's result is BOUND, and
`src/codegen/exprs/await.yo` (`generate_join_handle_await`) releases it after
the result has been read and dup'd. Two details matter:

- **Only when bound.** An unbound statement-level `io.spawn(...)` has no handle
  to keep alive — that is exactly what an absent `variable_name` means at that
  site — so fire-and-forget spawns (e.g. `tests/sys/timer.test.yo:35`) keep
  today's behaviour and do not leak.
- **Pairing the incr with the await keeps it leak-free**, at the cost of
  requiring a handle be awaited AT MOST ONCE. Verified against the corpus: 18
  handles across `tests/async_await.test.yo` and
  `tests/codegen-bootstrap/io_spawn_join_handle.yo`, zero double-awaits. This
  is the same single-use contract Rust's `JoinHandle::join` enforces by taking
  self by value.

**Refinement to the analysis below, from instrumenting the emitted C.** The
refcount table further down said the future reaches 0 at the scope-end drop.
Printing the counts showed otherwise, and the real sequence is worse to reason
about: the hanging case reads rc=2 after spawn, rc=1 after the loop body's
drop, and rc=1 at await ENTRY — the future is still alive when the await
begins. It is the RUNTIME's release-on-completion that takes the last
reference, mid-poll, while the handle still points at the state machine. The
working (drop-removed) variant shows the same trace one higher: rc=2 at await
entry, then 1 — i.e. the completion release is visible as the drop from 2 to 1.
So the fix is the same, but the free happens DURING the await rather than
before it.

Verified: the loop variant now completes 4/4 in 508 ms (was: hang), the
recursion variant 4/4 in 509 ms (was: hang), the unrolled control still 503 ms,
and the original motivating case — four concurrent CHILD PROCESSES spawned from
a loop — runs in 2033 ms rather than the 8000 ms a serial fallback would need.
Gate: `tests/async_await.test.yo` "Test spawn inside a loop runs tasks
concurrently", red-first verified (the pre-fix compiler hangs; the test run
times out at rc=124 with zero check errors).

Consequence for `plans/CHUNKED_C_EMISSION.md` step 3: the parallel driver's
shell-script workaround is no longer forced. Replacing it with native
`io.spawn` is now possible and is recorded there as a follow-up.

## Symptom

`io.spawn(task, io)` gives real concurrency when the spawn calls are UNROLLED
in a function body, but the program **hangs forever, spinning at 100% CPU**,
when the `io.async` + `io.spawn` pair is executed from inside a `while` loop
body or from a recursive (`recur`) call. No output, no progress, no children
started; `timeout` has to kill it (rc=124).

`yo check` passes all of these, and so does codegen — the C compiles and links
cleanly. The failure is purely at runtime.

## Bisected: six variants, same task shape

All variants spawn tasks that `io.await(sleep(500ms))` and then join them.
`clang -O2`, macOS arm64, compiler at develop + PR #234.

| # | shape | result |
|---|---|---|
| A | 2 tasks + 2 `io.spawn`, unrolled, directly in `main` | **works — 504 ms** (concurrent) |
| C | as A, but the `JoinHandle.await` calls are in a `while` loop over `ArrayList(JoinHandle(u64))` | **works — 509 ms** |
| E | as A, but moved into a helper `fn(io : Io) -> usize` (io as a plain parameter) | **works — 501 ms** |
| F | a `while` loop in `main` that CALLS the variant-E helper twice | **works — 1013 ms** (2 waves) |
| B | `io.async` + `io.spawn` INSIDE a `while` loop, handles pushed to an `ArrayList` | **HANGS** (killed at 30 s) |
| D | `io.async` + `io.spawn` in a helper that ends with `recur(n - 1, …)` | **HANGS** (killed at 30 s) |

So: awaiting handles in a loop is fine, collecting handles in an `ArrayList` is
fine, and spawning from a plain-`io`-parameter helper is fine. The trigger is
specifically **creating/spawning a task from a loop body or a recursive call**.

## Minimal reproducer (variant B — hangs)

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
sleep_mod :: import("std/sys/timer");

main :: (fn(io : Io) -> unit)({
  handles := ArrayList(JoinHandle(u64)).new();
  (i : usize) = usize(0);
  while(i < usize(4), {
    task := io.async((io : Io) => {
      _a := io.await(sleep_mod.sleep(u64(500)), io);
      u64(1)
    });
    handles.push(io.spawn(task, io));
    i = (i + usize(1));
  });
  (done : usize) = usize(0);
  (j : usize) = usize(0);
  while(j < handles.len(), {
    match(handles.get(j), .Some(h) => match(h.await(io), .Some(_v) => { done = (done + usize(1)); }, .None => ()), .None => ());
    j = (j + usize(1));
  });
  println(`done=${done.to_string()}/4`);
});
export(main);
```

Control (variant A, same file structure without the loop) completes in ~504 ms.

## Why it matters

Any "fan out N concurrent tasks" loop — the natural way to write a worker pool,
a parallel download, or a parallel compile driver — deadlocks. The pattern is
idiomatic and the failure mode is the worst kind: silent, total, and invisible
to `yo check` and to codegen.

It currently blocks `plans/CHUNKED_C_EMISSION.md` step 3 (spawn one `cc -c` per
chunk), where N is dynamic by construction.

## Workaround (verified, variant F)

Put the unrolled spawns in a helper function and loop over WAVES of that
helper — the loop then contains only a plain call, no `io.async`/`io.spawn`:

```rust
_wave :: (fn(a : String, b : String, io : Io, exn : Exception) -> usize)({
  t1 := io.async((io : Io) => { /* … a … */ u64(1) });
  t2 := io.async((io : Io) => { /* … b … */ u64(1) });
  h1 := io.spawn(t1, io);
  h2 := io.spawn(t2, io);
  /* await both */
});
// caller: while(more_waves, { total = (total + _wave(x, y, io, exn)); … });
```

This bounds the concurrency window to the unrolled arity, which for a job
scheduler is acceptable (it is the `--jobs` cap anyway) but it is not a fix.

## ROOT CAUSE (confirmed at the C level, not a guess)

**A `JoinHandle` stores a BORROWED raw pointer to the task future and takes no
reference, so the handle dangles as soon as the future's owning local goes out
of scope. A loop body is a scope; a function body is not.**

The spawn lowering (`src/codegen/exprs/generation.yo:324-363`,
`_generate_io_spawn`) ends with

```rust
.Some(jh) => `(${jh}){ .__future = (void*)${spawn_var.clone()} }`,
```

— its own comment calls the handle a "non-owning view". The only `__yo_incr_rc`
it emits (`:354`) is inside the cold-start branch and represents the
RUNNING/scheduled task, not the handle. `JoinHandle.await`
(`src/codegen/exprs/await.yo:715-753`) then reads `handle.__future`, polls
`header->state` in a `while (__jh_state != -1 && __jh_state != -2)` loop
calling `__yo_async_poll_step()`, and never touches the refcount either.

So the refcount history of a spawned future is:

| step | RC |
|---|---|
| `io.async(...)` creates it, bound to a local | 1 |
| `io.spawn` cold-starts it (`:354` incr) | 2 |
| enclosing SCOPE ends -> local's drop | 1 |
| task completes -> runtime releases the running ref | **0 -> freed** |
| `JoinHandle.await` dereferences `handle.__future` | use-after-free |

In the UNROLLED variants the local's drop is at FUNCTION end, i.e. after the
awaits, so RC never reaches 0 while a handle is live. In the loop variant the
drop is emitted at the end of each ITERATION — the emitted C is literally

```c
while (true) {
  ...
  { // begin block (loop body)
  _file____priv_temp_6446_state_t* task = __yo_new__file____priv_temp_6446(...);
  // io.spawn — start cold Future, return JoinHandle
  ...
  push(handles, (__yo_t3){ .__future = (void*)__spawn_future_... });
  if (task != NULL) { __yo_decr_rc((void*)task); };   // <-- kills the handle
  } // end begin block (loop body)
}
```

so every handle in `handles` points at a future that will be freed on
completion. The await then polls freed memory forever — which is exactly the
observed 100% CPU spin. Recursion (variant D) hangs for the same reason: each
frame's local is dropped when that frame returns, before the caller awaits.

**Proof:** deleting that single `__yo_decr_rc((void*)task)` line from the
emitted C of the hanging variant B and recompiling makes it pass —
`done=4/4 in 507ms`, fully concurrent. Nothing else changed.

This also means the current design carries an undocumented aliasing invariant:
*the future's owning binding must outlive every `JoinHandle.await` on it.*
Nothing checks it.

## Fix directions

The complete fix is to make `JoinHandle(T)` an OWNING handle: `__yo_incr_rc` the
future when constructing the handle, and release it when the handle dies. That
needs the handle's RC treatment wired up (its `__future` field is a bare
`void*`, so dup/drop/dispose do not know it owns anything) — the same
dup/drop/dispose plumbing every other RC-carrying type gets.

Two smaller changes are each a strict safety improvement but LEAK one reference
per spawned task (a future SM struct), so neither is a complete answer:

1. incr at handle construction with no matching release — turns the UAF into a
   leak. Careful: adding a release inside `JoinHandle.await` instead would
   reintroduce a UAF for a handle awaited twice.
2. mark `io.spawn`'s argument as CONSUMED in the evaluator so the local's
   scope-end drop is never emitted (ownership moves into the runtime) — same
   leak, but it removes the drop rather than adding an incr.

Note this is NOT a port error: the lowering is a faithful port of the TS
`generateFuncCall` io.spawn block (generation.ts:702), so the TS compiler has
the same gap.

## Where to look

`src/codegen/exprs/generation.yo:324-363` (`_generate_io_spawn`),
`src/codegen/exprs/await.yo:665-755` (`generate_join_handle_await`), and the
scope-end drop emission in `src/codegen/exprs/drop_dup.yo` /
`_optimize_dup_drop_pairs` in `src/evaluator/exprs/begin.yo` for the consumed
route.

## Test to add with the fix

`tests/async_await.test.yo`: a spawn-in-loop test (4 tasks, assert all four
complete and the elapsed time is closer to one task's duration than to four).
**Do not add it before the fix** — a hanging test would hang the whole suite
and CI, since the runner has no per-test timeout.
