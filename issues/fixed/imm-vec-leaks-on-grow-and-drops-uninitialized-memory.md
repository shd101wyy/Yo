# `imm/Vec` leaks one reference per element on every grow, `pop` and `reverse`, and drops uninitialized memory in five methods

**Status: FIXED 2026-09-06** (`std/imm/vec.yo`; `Deque._grow` got the same C35
guard in the same change). Found by the std API stabilization audit
(`plans/STD_API_STABILIZATION.md` §3 item 1).

**Severity: memory safety.** Silent for every RC element type (`ImmString`, a
nested imm `Vec`, any `Send + Acyclic` aggregate) — and invisible to the test
suite, whose only RC-element test pushed 3 elements into a capacity-4 vector
(no grow) and popped a SHARED vector (the copy path).

## The leaks — measured with `rc()` on one shared `ImmString` witness

| operation (unique owner) | want | got | why |
| --- | --- | --- | --- |
| `with_capacity(1).push(s).push(s)` (second push grows) | 3 | **4** | `_copy_elems` dups every element into the new buffer, then the old buffer is `free`d without dropping — +1 per element per grow (`push` :144-149) |
| `concat` that grows | 6 | **7** | same shape (`concat` :236-247) |
| `new().push(s).pop()` | 2 | **3** | `val := slot.*` dups; the unique path only shrinks `_len`, so the slot's own reference is now outside `Dispose`'s loop and is never released (`pop` :189-193) |
| `new().push(s).push(t).reverse()` (in place) | 2 | **3** | the swap used `consume(...)` — *initialize without dropping* — on two LIVE slots, so each overwritten reference was lost |

(The audit's grow-path attribution was right; the `reverse` leak was found by
applying the same reasoning to the in-place swap. Counts above are with a
develop-built compiler; the v0.2.24 seed adds a separate, already-fixed +1 per
`own(self)` call in generic impls — #428 — which is why the first probes read
one higher still.)

## The drops of uninitialized memory

`map` (:292), `filter` (:304), the copy path of `reverse` (:281), the copy path
of `dedup` (:408) and `zip_with` (:425) wrote `(new_ptr.add(i)).* = v` into a
fresh `malloc` buffer. A bare deref-store DROPS the destination's previous
value; only `consume(dst.* = v)` initializes. On zeroed fresh pages the bogus
drop is a no-op, which is why nothing crashed — under
`MallocPreScribble=1 MallocScribble=1` (0xAA-filled allocations) the
`initialize fresh buffers` test dies with SIGSEGV before the fix and passes
after.

## Fix

- Unique-owner grow paths MOVE the elements as raw bytes (`_move_elems` →
  `memcpy`): ownership travels with the bytes, nothing is dup'd, the old buffer
  is just freed. `_copy_elems` (dup per element) stays for the buffer the
  source keeps sharing (`concat`'s `other`, every `rc > 1` copy path).
- `pop`'s unique path `unsafe.drop`s the slot it vacates.
- The in-place `reverse` swap uses plain stores (drop the overwritten value,
  dup the stored one — the three stores balance).
- The five fresh-buffer stores are `consume(...)`.
- `_raw_alloc` and `Deque._grow` gained the C35 `size_would_overflow` guard
  (`Deque` also clamps its doubling loop, which could wrap to 0 and spin); they
  were the two collections `issues/fixed/collection-capacity-overflow-unchecked.md`
  left out.

## Regression tests

`tests/imm_vec.test.yo`: five `rc()`-witness tests, one per path, red-first on
the unpatched std with a develop-built compiler (4/5 by count; the fifth by
SIGSEGV under `MallocPreScribble`).

## Lesson

**Probe std reference counts with a compiler built from the tree, never with the
PATH `yo` (the seed).** The seed is the PREVIOUS release: here it lacked #428,
so every count read one higher than the std bug alone explained, and the first
two rounds of "fixes" appeared not to work.
