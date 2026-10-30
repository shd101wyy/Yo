# `Arc.make_mut` and `Arc.try_unwrap` race an `ArcWeak.upgrade` on another thread

**Severity:** S1 — with an `ArcWeak` to the only `Arc`'s cell held on another thread, an `upgrade` that lands between the uniqueness check and the write (`make_mut`) or the move-out (`try_unwrap`) hands that thread a handle to a payload the owner is writing in place or has moved out: a data race, and a read after the owner dropped what it moved.

**Found:** 2026-10-28, landing `make_mut`'s disassociation of `Weak` (W3 Generation B, branch `vbd/make-mut-weak-gen-b`).

**Status:** fixed. Generation A (`fix/arc-unique-lock-gen-a`, 2026-10-29)
added the lock primitives to the runtime; Generation B
(`fix/arc-unique-lock-gen-b`, on the v0.2.73 seed, which emits them) makes
`make_mut` and `try_unwrap` take the lock. See "Fix" below.

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
runtime primitive called from the prelude is seed-gated. `src/` does not
instantiate `Arc.make_mut` or `Arc.try_unwrap` (only `Rc.make_mut`), but the
prelude's `extern` block names symbols that a pre-v0.2.73 seed does not
emit (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

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

## Fix

- **Generation A** (`src/codegen/functions/gc_runtime.yo`,
  `_weak_count_primitives`, both runtimes): `__yo_arc_lock_unique(cell)`
  CASes the strong count from 1 to 0 (acquire) and keeps the tag bit;
  `__yo_arc_unlock_unique(cell)` adds the 1 back (release);
  `__yo_arc_weak_count_raw(cell)` reads the weak word without the
  zero-strong-count shortcut; `__yo_arc_release_locked(slot)` ends a locked
  cell whose payload was moved out: one `fetch_or` sets the dead bit, the
  cell is freed when no `ArcWeak` is left, and the holder's handle at `slot`
  is cleared to NULL. Clearing the handle is the one departure from Rust,
  which calls `mem::forget`: an `Arc` is a copyable handle, so passing it to
  `__yo_ptr_write` dups it instead of forgetting it, and its release of
  NULL is already a no-op.
- **Generation B** (`std/prelude.yo`): `try_unwrap` locks, moves the
  payload out and calls `__yo_arc_release_locked`, so an `ArcWeak` never
  upgrades to a moved-out payload. `make_mut` locks and reads the raw weak
  count. When it is zero, it unlocks and writes in place. Otherwise it moves
  the payload out under the lock, ends the old cell with
  `__yo_arc_release_locked`, and stores `arc(payload)` in the cleared slot.
  That is Rust's move, with no clone (Fable consultation #2, verdict A3).
  When the lock fails, it clones as before. `Rc.make_mut` moves in the
  weak-only case too (`__yo_rc_forget_payload`, then `self = rc(payload)`),
  and WEAK_AND_UNCOLLECTED_RC §3.3 says so.
- **Tests:** `tests/arc.test.yo` drives the primitives through an
  `extern("Yo", ...)` block (a locked cell refuses `upgrade` on another
  thread and its raw weak count still reads; the unlock lets the next
  upgrade see a write made under the lock; a moved-out locked cell goes to
  its `ArcWeak` as dead or is freed), and runs the stress loop above 300
  times as a row of the TSan thread corpus. A row per handle kind pins the
  move: with a live `ArcWeak` on another thread, or a `Weak`, the write
  lands in a fresh cell, no `Clone` and no payload drop runs, the old cell
  stays allocated until the weak handle frees it, and the weak handle
  upgrades to `.None`.
  `tests/internal/gc_runtime_atomics.test.yo` pins the orderings.
