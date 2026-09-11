# `Thread.spawn` / pool-task closures leak their RC'd captures

**Status:** FIXED 2026-09-11. **Was pre-existing** — reproduced identically on `develop` with
`std/worker.spawn` and on `s2/d7-threadpool` with `std/thread`'s
`spawn(pool, cb)`. Found while reviewing STD_API_AUDIT D7.

**Severity:** MEDIUM — an unbounded memory leak, not a correctness bug. It
matters now because `ThreadPool.join_all` allocates a `Channel(bool)`
internally on **every call**, so a program that drains a pool in a loop leaks
steadily even if its own task closures capture nothing.

**It also blocks a feature (2026-09-11).** The never-released capture means a
captured handle's `Dispose` never runs, so any std API whose contract is "the
last handle to go does X" is silently inert across a `Thread.spawn` boundary.
The first case is `std/sync/channel`'s `Sender`/`Receiver` split: a `Sender`
moved into a spawn closure never decrements the sender count, so the channel
never auto-closes. Measured side by side —
`issues/repros/thread-spawn-capture-blocks-channel-autoclose.yo` prints `true`
for a sender dropped in a plain scope and `false` for the same sender captured
by `Thread.spawn`. So this is no longer only about memory: it is the reason
that feature ships with a documented "mint the sender inside the thread"
pattern instead of the Rust one
(`plans/archive/SPAWN_CAPTURE_AUTOCLOSE.md`). An `io.async` capture releases
correctly; this is specific to `__yo_thread_spawn` / `__yo_worker_spawn`.

## Symptom

Every closure handed to a spawn primitive leaks **one reference per RC'd
capture field**. The reference taken when the capture struct is built at the
call site is never released.

## Measured

`--release`, macOS arm64, `maximum resident set size` from `/usr/bin/time -l`,
2 worker threads:

| program | 200 iterations | 20 000 iterations | leak/iteration |
| ------- | -------------- | ----------------- | -------------- |
| `pool.join_all()` in a loop (no user captures at all) | 1 654 784 B | 8 454 144 B | ~344 B |
| user task capturing a fresh `Channel(bool)`, via `spawn(pool, cb)` | 1 638 400 B | 8 454 144 B | ~344 B |
| same, on `develop` via `Worker.spawn(cb)` | 1 654 784 B | 8 519 680 B | ~347 B |

~344 B is one `Channel(bool)` object graph (channel + its mutex + two
condvars + the `AtomicUsize`/`AtomicBool` + the element buffer).

## Root cause

`src/codegen/exprs/parallelism.yo` intends the documented
"heap-copy → dup → run → drop → free" wrapper
(`issues/fixed/thread-closure-own-capture-double-free.md`), but **both** the
dup (`_generate_spawn_call`, the `get_dup_function_for_type` match) and the
drop (`_generate_spawn_wrapper`, the `get_drop_function_for_type` match) are
emitted only when the capture type resolves a `___dup` / `___drop` C function.

`get_drop_function_for_type` / `get_dup_function_for_type`
(`src/codegen/exprs/drop_dup.yo:47-54`) resolve through the type-trait-method
registry, and the self-hosted compiler **synthesizes no `___dup`/`___drop`**
for an anonymous closure-capture struct. So both matches take `.None` and the
wrapper degenerates to:

```c
static void __yo_spawn_wrapper_yo_id_9037(void* closure) {
  closure_yo_id_7845(closure, (__yo_t26){0});
  __yo_free(closure);          // <-- no ___drop of the capture struct
}
```

Dup and drop cancel each other for the *heap copy*, so this is not a
double-free — but the `+1` taken when the capture struct is constructed at the
call site

```c
__yo_t57 __capture_closure_yo_id_7845_14 =
  (__yo_t57){ .drained = ((__yo_t19*)__yo_incr_rc_atomic((void*)(drained))) };
```

has no matching decrement anywhere, so the captured object is never freed.

Secondary (same site, smaller): when the closure **literal** is the direct
argument of the extern spawn primitive — as in `ThreadPool.join_all` — the
capture struct is built **twice** (`..._13` and `..._14`, each with its own
`__yo_incr_rc_atomic`) and only the second is used, so that shape leaks two
references per spawn instead of one.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ ThreadPool, spawn } :: import("std/thread");
{ Channel } :: import("std/sync/channel");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  pool := ThreadPool.new(usize(2));
  (r : i32) = i32(0);
  while(runtime(r < i32(20000)), {
    ch := Channel(bool).new(usize(1));
    spawn(pool, (io) => {
      ch.send(true);
      ()
    });
    ch.recv().unwrap();
    r = (r + i32(1));
  });
  println(`done`);
});
export(main);
```

Compile `--release` and compare `maximum resident set size` against the same
program with `i32(200)`.

## Fix direction

Synthesize `___dup` / `___drop` for closure-capture structs (or make the spawn
emitter fall back to `generate_drop_code_for_value` over the capture struct's
runtime fields, which already knows how to emit per-field RC decrements)
**and** drop the capture value at the call site once ownership has moved to the
heap copy. Fixing the doubled capture-struct construction for the
literal-argument shape is a separate, smaller change in the same emitter.

## Fix

`src/codegen/exprs/parallelism.yo` — `_emit_capture_drop_lines` is the `.None`
arm the wrapper used to take as a no-op. It walks the capture struct's runtime
fields with `generate_drop_code_for_value` (which already handles nested
arrays, tuples and enums), snapshotting `em.code`, unhooking the
`declared_ref`/`scope_ref` trackers so the moved lines are not recorded as
declarations of the enclosing function, and re-emitting the produced lines into
the DECLARATION buffer where a spawn wrapper lives — the same
snapshot-and-rewrite `codegen/functions/generation.yo` uses for its FTT stub.

No dup is added at the call site to match: the heap copy is a shallow copy of
the call-site struct, so it INHERITS that struct's references — the spawn is a
move and exactly one release balances it.

`src/codegen/functions/declarations.yo` gains the two forward declarations that
made this legal C. `__yo_decr_rc_atomic` and `__yo_incr_rc_atomic` are defined
in the CODE buffer, which lands after the whole declaration buffer, so the
wrapper's call to the first was an implicit declaration followed by a `static`
definition — a hard error, not a warning.

Verified red-first with a module-level Dispose counter (CI runs
`detect_leaks=0` on every platform, so a leak sanitizer reports nothing):
0 disposes under the v0.2.30 seed, 1 with the fix. `tests/thread.test.yo`
carries that as two tests — exactly once, and sixteen times across sixteen
iterations. `issues/repros/thread-spawn-capture-blocks-channel-autoclose.yo`
now reports `true` on both lines, which closes
`plans/archive/SPAWN_CAPTURE_AUTOCLOSE.md`.

The doubled capture-struct construction for the literal-argument shape, noted
below, is a separate defect in the same emitter and is untouched.
