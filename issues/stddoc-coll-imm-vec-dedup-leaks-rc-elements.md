# `imm.Vec.dedup` leaks every refcounted element on its uniquely-owned path

**Status:** OPEN
**Severity:** memory leak of RC element types — silent, and invisible to every
existing test because `tests/imm_vec.test.yo` deduplicates `i32`s.
**Found:** 2026-09-11, during the `///` documentation sweep of
`std/imm/vec.yo`, while checking the complexity claim of `dedup`.

`dedup`'s unique-owner branch (`rc(self) == usize(1)`,
`std/imm/vec.yo:444-489` after this sweep's doc edits — the `count`/`i`
compaction loop) writes each kept element into an **already-initialized** slot
with `consume`:

```rust
elem := (self._ptr.add(i)).*;          // dup
...
if(!found, {
  if(count != i, {
    consume((self._ptr.add(count)).* = elem);   // ← live slot, no drop
  });
  count = (count + usize(1));
});
...
self._len = count;                     // ← tail slots orphaned, never dropped
```

`consume(p.* = v)` means "initialize fresh memory": it stores without dropping
what it overwrites. That is right for the fresh `_raw_alloc` buffer of the
copying branch below it, and wrong here — the slot at `count` still holds a
live handle. The truncation then puts the remaining slots `[count, old_len)`
outside `Dispose`'s loop, which walks `[0, _len)` only, so their references are
orphaned too.

The file already documents this exact hazard **two methods up**, in `reverse`,
where it was fixed:

```rust
// A swap of two LIVE slots: a plain store drops the value it overwrites
// and dups the one it stores, so the three stores balance. `consume`
// (initialize, no drop) is for FRESH memory only — used here it leaked
// one reference of each swapped element.
```

`dedup` was listed in the same P0 row that fixed `reverse`
(`plans/STD_API_STABILIZATION.md` §3 item 1,
`issues/fixed/imm-vec-leaks-on-grow-and-drops-uninitialized-memory.md`), and
its COPYING path was converted to `consume` correctly; the unique path's
live-slot store was not part of that change.

## Reproducer

`issues/repros/stddoc-coll-imm-vec-dedup-leaks-rc-elements.yo` — three atomic
`ref` handles (two equal, so `dedup` drops one) counting their disposals in a
module-level global:

```
$ yo compile issues/repros/stddoc-coll-imm-vec-dedup-leaks-rc-elements.yo \
    --std-path ./std --optimize 2 -o /tmp/dedup_leak && /tmp/dedup_leak
len after dedup: 2
disposed: 0 (expected 3)
```

Two controls isolate it to the unique-owner path:

| variant | disposed |
| --- | --- |
| the same program **without** the `dedup()` call | 3 (correct) |
| `kept := v;` before `dedup()`, so `rc(self) > 1` and the COPY path runs | 3 (correct) |
| as written (uniquely owned, `dedup()` runs the compaction) | **0** |

`len` is right in every case — only the refcounts are wrong, which is why no
functional test notices.

## Fix sketch (not applied here — this is a documentation-only PR)

In the unique branch, either
* store with a plain `(self._ptr.add(count)).* = elem` (drops the overwritten
  handle, dups the stored one — the balance `reverse` relies on), and drop the
  orphaned tail `[count, old_len)` before shortening `_len`; or
* drop the duplicate as soon as it is detected and keep a plain store, which
  makes the tail dead by construction.

The regression test wants the Dispose counter above, not a `len` assertion: CI
runs with `detect_leaks=0` everywhere, so a leak is only observable as a
missing disposal.
