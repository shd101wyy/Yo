# `__yo_borrow_acquire` on an atomic object is a plain `borrow_count++`, and a user `Index` impl on an atomic object panics deterministically

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-18;
raised by the runtime sub-audit, re-run here).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. Two defects in one mechanism: (1) **data race** on the borrow counter of a
shared atomic object; (2) **false panic** with a single thread for any user type that implements
`Index` with `inout(self)` on an atomic (or plain) object.
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64;
`issues/repros/user-index-on-an-atomic-object-panics-on-a-borrowed-interior-ref.yo` (rc 134,
one thread) and `issues/repros/borrow-count-on-an-atomic-object-from-two-threads.yo` (rc 134,
both threads panic). Both need the pragma because `Index.index` returns `*(Output)`.

## Mechanism

`src/codegen/exprs/other_fn_call.yo` (~315-352): when an interior reference into a container
(`c(i)`) is passed to an `inout(...)` parameter, codegen emits `__yo_borrow_acquire((void*)(c))`
before the call and `__yo_borrow_release` after, and the container qualifies when it is
`is_reference_struct_type || is_atomic_reference_struct_type`. The primitives
(`src/codegen/functions/gc_runtime.yo` ~280-296) are plain `borrow_count++` / `--` on the
`uint16_t` in the RC header. An atomic object is shared across threads by design, so two threads
doing `read(c(i))` race on that word: a lost update leaves it stuck non-zero (every later
container operation panics "container operation while an interior reference borrows from it")
or underflows to `0xFFFF` (saturation panic on the next acquire).

The single-thread panic: the caller acquires the borrow on `c` BEFORE calling `index`, and the
emitted `index` body begins with `__yo_borrow_assert_unborrowed((void*)(*self))` (the
`inout(self)` prologue, `src/codegen/functions/generation.yo` ~498-547), so `read(c(usize(1)))`
trips its own borrow. std's `ArrayList` escapes only because its index body does not get the
assert; the machinery is unusable for user `Index` impls.

## Fix direction

1. For an atomic container, either make the counter atomic (`atomic_fetch_add_explicit` relaxed
   on a `_Atomic uint16_t`; the assert becomes an acquire load) or do not emit the borrow pair
   at all — the interior ref of an atomic object is a shared location by construction, and the
   Phase O/D3 rule (no `inout` into an atomic root, `phase-o-atomic-write-gate-misses-…`) makes
   the `inout(x) : Output` call illegal in safe code anyway. Recommended: emit nothing for atomic
   containers once D3 lands; pragma'd code that indexes an atomic object gets the atomic counter.
2. The `index` method's `inout(self)` prologue must not assert against a borrow the CALLER took
   for this very call: skip the assert for the `Index`/`IndexMut` entry (the caller's acquire
   is what makes the returned pointer valid), or acquire after the call returns.
3. Tests: both repros in `tests/borrow*.test.yo` (single-thread must print `ok 2`; the two-thread
   form must run clean under the TSan job).

## Fix (2026-09-26)

1. **Atomic counter for atomic containers.** `__yo_borrow_acquire_atomic` /
   `__yo_borrow_release_atomic` / `__yo_borrow_assert_unborrowed_atomic`
   (`src/codegen/functions/gc_runtime.yo`) touch the same `uint16_t` header word atomically (a
   CAS loop keeps the saturation check); `_emit_borrow_acquires` (`src/codegen/exprs/other_fn_call.yo`)
   picks them when the container is an atomic object and hands the matching release calls back,
   and the `inout` entry assert (`src/codegen/functions/generation.yo`) uses the atomic form for
   an atomic parameter. "Emit nothing for atomic containers" was not taken: D3 still allows a
   READ-ONLY `inout` binding into an atomic object, so two threads can take interior
   references at once in safe code.
2. **No self-inflicted panic.** Functions reached as an index-trait call's `index_method_value`
   are recorded during collection (`mark_as_index_entry_method`, `src/function_value.yo`) and
   their entry assert is skipped: the caller takes the borrow before the argument expression — the
   `index` call itself — runs. Any reallocation such a method performs goes through a callee
   that asserts on its own entry, or the realloc/free auto-assert.

Tests (`tests/unsafe_cast_rc_borrow.test.yo`, which carries the pragma `Index` needs): both
repros — a user `Index` on an atomic and on a plain ref object through an interior `inout`
argument (red on the unfixed codegen: abort, exit 6), and two threads reading through the
atomic object's `Index` 10000 times each (also red before: the same abort).
