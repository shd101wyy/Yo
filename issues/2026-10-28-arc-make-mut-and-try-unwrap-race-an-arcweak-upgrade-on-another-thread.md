# `Arc.make_mut` and `Arc.try_unwrap` race an `ArcWeak.upgrade` on another thread

**Severity:** S1 — with an `ArcWeak` to the only `Arc`'s cell held on another thread, an `upgrade` that lands between the uniqueness check and the write (`make_mut`) or the move-out (`try_unwrap`) hands that thread a handle to a payload the owner is writing in place or has moved out: a data race, and a read after the owner dropped what it moved.

**Found:** 2026-10-28, landing `make_mut`'s disassociation of `Weak` (W3 Generation B, branch `vbd/make-mut-weak-gen-b`).

## Symptom

Both methods decide "`self` is the cell's only handle" with plain loads of
the counts (`std/prelude.yo`, the `Arc` impls under `where(T <: (Send, Sync,
Clone))` and `where(T <: (Send, Sync))`):

- `Arc.try_unwrap` reads `ref_count(self) == 1`, then reads the payload
  bitwise and clears the cell's `dispose_fn` (`__yo_rc_forget_payload`).
- `Arc.make_mut` (after W3 Generation B) reads `ref_count(self) != 1`, then
  `__yo_arc_weak_weak_count(cell) != 0`, and writes in place when both are
  false.

`ArcWeak.upgrade` (`__yo_arc_weak_upgrade`, `src/codegen/functions/gc_runtime.yo`)
takes a strong count with a CAS whenever the count is non-zero. Nothing stops
it between the owner's check and its write:

1. `try_unwrap`: main reads strong = 1; thread T upgrades (strong 2); main
   moves the payload out and forgets it; T now holds an `Arc` whose payload
   bytes main owns and may drop (a `String`'s buffer freed under T's read).
2. `make_mut`: main reads strong = 1; T upgrades (strong 2) and drops its
   only `ArcWeak` (weak 0); main reads weak = 0 and writes in place while T
   reads through its upgraded handle.

Before W3 Generation B, case 2 needed no second step: `make_mut` never
looked at the weak count, so any `ArcWeak` that upgraded after the strong
check raced the write. Generation B narrows the window to the two loads; it
does not close it. `Rc` is single-threaded and is not affected.

`try_unwrap` is callable from safe code; `make_mut` on an `Arc` only under
`Pragma.AllowUnsafe` (a `&mut` receiver on an atomic object).

Stress repro: `issues/repros/2026-10-28-arc-make-mut-races-an-arcweak-upgrade.yo`.
It did NOT report under ThreadSanitizer in 2,000 rounds of each loop
(2026-10-28, a tree binary at `c847d0b76` with this branch's std): the window
is two adjacent loads, and a spawned thread rarely reaches its `upgrade`
inside it. The race is read off the code, the same derivation Rust's
`Arc::make_mut` and `Arc::try_unwrap` comments give for their CAS.

## Root cause

Rust closes the window by making the check an atomic transition: `make_mut`
and `try_unwrap` CAS the strong count from 1 to 0, so a concurrent
`upgrade` (which refuses a zero count) fails, and only then inspect the weak
count; `make_mut` restores the count to 1 when no `Weak` exists. Yo's prelude
has no primitive that performs that CAS on an `Arc` cell's header, and a new
runtime primitive called from the prelude is seed-gated: `src/` instantiates
`Arc` methods, so the seed must emit the primitive before the prelude can
call it (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

## Proposed fix

- **Generation A (codegen):** `__yo_arc_lock_unique(cell) -> bool` in
  `_weak_count_primitives`: CAS strong 1 → 0 (acquire); and
  `__yo_arc_unlock_unique(cell)`: store 1 (release); plus a raw weak-count
  read that does not answer 0 for a zero strong count. The weak side already
  treats a zero strong count as "payload gone" for `upgrade`, so a locked
  cell refuses upgrades.
- **Generation B (prelude, on a seed carrying A):** `make_mut` locks; on
  failure it clones; on success it reads the weak count: zero → unlock and
  write in place; non-zero → move to a fresh cell (the old one is handed to
  the `ArcWeak`s as dead). `try_unwrap` locks and moves out under the lock,
  leaving the cell to the weak side as `make_mut`'s non-zero branch does.
- **Test:** the interleaving cannot be forced from Yo source today, so the
  fix's test drives the primitives directly: with the cell locked
  (`__yo_arc_lock_unique`), `ArcWeak.upgrade` answers `.None` and the weak
  count still reads; after the unlock it answers `.Some`. Beside it, the
  repro's loop as a stress row in `tests/arc.test.yo` for the TSan CI job.
