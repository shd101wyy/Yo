# `imm.Vec.dedup` leaks every refcounted element on its uniquely-owned path

**Status:** OPEN — **but the diagnosis below is WRONG, and the leak is not a
`std` bug.** Re-measured 2026-09-14; see "Correction" at the end. The real
cause is a compiler defect,
`issues/own-param-leaks-when-a-conditional-return-is-not-taken.md`, and this
doc should close when that one does.
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

---

## Correction (2026-09-14) — the `consume` store is not what leaks

The mechanism described above is real: `consume(p.* = v)` does not drop what it
overwrites, and using it on a live slot would leak. **It is not what this
reproducer is measuring.** Three controls, each removing the `consume` store
from the picture:

| variant | disposed | what it removes |
| --- | ---: | --- |
| `dedup` on `[1, 2, 3]` — no duplicates, so `count == i` always and the store NEVER executes | **0** | the store |
| the whole unique branch replaced by a bare `return(self)` — no loop, no store, no `_len` change | **0** | the store AND the loop |
| the same branch reached from the FIRST early return instead of the second | **3** ✅ | nothing — only *which* return fires |

The first two delete the accused code and the leak survives. The third changes
no code at all and the leak disappears. So the accusation does not hold.

`contains` / `index_of` perform the same `(self._ptr.add(j)).*` element reads
and do not leak, which also rules out the reads.

### What actually leaks

`dedup`'s prologue is two guards:

```rust
if(self._len <= usize(1), { return(self); });      // untaken for len > 1
if(rc(self) == usize(1), { … return(self); });     // the unique path
```

An `own` parameter is never dropped when the body contains an
`if(cond, { return(param); })` whose condition is **false at runtime** — so the
first guard, merely by not firing, orphans `self` for every vector longer than
one element. Filed with a 30-line reproducer and a six-shape control matrix as
`issues/own-param-leaks-when-a-conditional-return-is-not-taken.md`.

That also explains the number this doc could not: the reproducer reports **0**
disposals, not the 1 its own header predicts and not the 1 the `consume`
mechanism would cause. The entire vector is orphaned, so none of its three
elements is ever disposed.

### What to do

- **Do not "fix" `dedup`** by rewriting the unique path. It would not fix the
  leak (the controls above show the leak without that code), and it would make
  the real defect harder to find by removing the clearest instance of it.
- The `consume`-into-a-live-slot hazard is nonetheless a latent bug in that
  branch and should be corrected **once the compiler defect is fixed**, when a
  regression test can actually distinguish the two. Until then there is no
  test that can tell a correct `dedup` from an incorrect one.
- This doc closes when the compiler issue closes, and the reproducer moves
  with it.

### Method note

The filed diagnosis was arrived at by reading, and it is a *plausible* reading
— `consume` on a live slot genuinely is a leak, and the file even documents
that hazard two methods up, which made it look confirmed. What was missing was
a control that removes the accused mechanism and checks whether the symptom
survives. That control took one `sed` and one recompile. The same lesson as the
two wrong expected-value tables found elsewhere in this clean-up pass: the
artefact under test cannot supply its own oracle.
