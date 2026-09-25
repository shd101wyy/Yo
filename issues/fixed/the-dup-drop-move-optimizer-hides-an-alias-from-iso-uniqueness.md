# The dup/drop MOVE optimizer hides a live alias from `^v`'s uniqueness walk

**Found:** 2026-09-26, implementing `plans/PARALLELISM_SOUNDNESS.md` Phase 2 (rule D2's
construction-time walk).
**Status:** FIXED 2026-09-26 (the Phase 2 PR).
**Class:** would-be data race in safe code (an `Iso` handed to another thread while a local on
the sending thread still reaches part of its graph).

## Repro

```rust
Wrap :: ref(struct(items : ArrayList(i32)));
main :: (fn() -> unit)({
  shared := ArrayList(i32).new();
  w := Wrap(items : shared);
  println(`rc(shared)=${rc(shared)}`);   // 1 — two live handles, one count
  r := ^w;                                 // walked w.items: count 1 → .Some
  shared.push(i32(1));                     // the "isolated" list, still reached here
});
```

## Root cause

`_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) cancels a local's dup into a
container against that local's scope-end drop — a MOVE — even when the local is used after the
store: `shared` and `w.items` then share ONE count, and the pairing keeps that memory-safe
(field reassignment defers the old value's drop). But a count no longer equals the number of live
handles, which is exactly what `^v`'s walk reads. Other shapes were measured and are accurate:
`alias := w.items` dups (count 2, `^w` refuses), and an `inout(alias) := w.items` binding makes `^w`
refuse too.

## Fix

The move optimizer runs per frame, and a hidden alias of an object inside `v` can only be a local
of the function that performs `^v` (`^` needs an owned local; the optimizer never cancels across
frames or for a dup in a deeper scope). So the `__yo_iso_unique` builtin marks every frame of its
enclosing function as isolating (`mark_function_frames_isolating`, `src/env.yo`), and the
optimizer skips a marked frame (`frame_is_isolating`). The enclosing blocks' optimizer runs after
their children — the `^` included — so the mark is in place when it matters. Cost: no move
elision in functions that isolate a value.

Test: `tests/iso.test.yo` "^ answers .None when an object inside the value is shared" — this
repro's shape; it returned `.Some` before the fix.
