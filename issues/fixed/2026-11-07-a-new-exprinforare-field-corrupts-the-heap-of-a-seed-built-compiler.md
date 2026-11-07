# A new `ExprInfoRare` field corrupts the heap of a seed-built compiler: #1797's enum-tag under-sizing, still in the v0.2.75 seed

**Severity:** S1. In every compiler that the v0.2.75 seed builds from a tree with the field, a heap-buffer-overflow aborts the first `check`. Found while landing O-1's `ExprInfoRare.origin` field (branch `vbd/o1-o2-origin-architecture`).

## Reproducer

Add `origin : Option(ArrayList(OriginRootPlace))` as the last field of `ExprInfoRare` (`src/expr_info.yo`). Then build the compiler with the v0.2.75 seed:

```bash
nix develop . --command bash -c 'yo build --std-path ./std --cc clang'
yo-out/<target>/bin/yo check tmp/fixme.yo --std-path ./std
# ArrayList.push: allocation failed (RSS stays ~4 MB: one huge bogus allocation)
```

Under ASan (`yo compile src/main.yo --sanitize address --allocator system`), the report is:

```
ERROR: AddressSanitizer: heap-buffer-overflow, READ of size 512
0x... is located 0 bytes after 504-byte region
#0 __asan_memcpy ... #1 std's Box.new specialization for ExprInfoRare
```

## Root cause

This is the bug #1797 fixed: `issues/fixed/2026-11-05-an-enum-with-a-payload-aligned-below-4-is-sized-with-a-one-byte-tag.md`, commit `4c895deaa`. The v0.2.75 seed predates that fix. `ExprInfoRare`'s five `Option(bool)` fields are each folded with a one-byte tag where C emits an `int`. The seed's `size_of(ExprInfoRare)` therefore stays 16 bytes short of the C struct, and `Box.new` allocates the folded size.

This doc's first diagnosis was wrong. It blamed the new field for a 16-versus-32 misfold. Measured on this branch's `ExprInfoRare`, in the `Box.new` size literal of the emitted C for `src/main.yo`:

- The develop-built compiler, which has #1797, folds `488ULL`.
- The seed v0.2.75 folds `472ULL`.

`Option(ArrayList(OriginRootPlace))` adds 32 bytes on both sides. So the un-boxed field takes the seed's fold to 496 while C's struct is 512. Allocated with its 8-byte header, that is the 504-byte region in the ASan report, and the 512-byte copy runs past it. Before the field, the seed's 16-byte deficit stayed inside mimalloc's 512-byte size class: the allocation was rounded up to 512 and C's write still fit. The new field pushed the struct past that slack. Any field that grows `ExprInfoRare` past the class boundary does the same until the seed carries the fix. The leakfix lane hit the same wall when it added a field there; it moved its data to an `ExprId` side table instead.

## Fix

The tree needs no change: #1797 sizes the tag as the C `int`, and a compiler built from this tree folds 488 bytes, the C size. A build from the v0.2.75 seed still under-sizes. The O-1/O-2 branch therefore declares the field as `origin : Option(Box(ArrayList(OriginRootPlace)))`. An `Option` over a `Box` is a nullable pointer of 8 bytes on both sides. It adds nothing the seed misfolds, and it keeps the seed's allocation inside the 512-byte class, as before the field. The hazard ends when `SEED_VERSION` carries `4c895deaa`.

## Test that pins it

`tests/basic.test.yo` ("an enum tag is int-sized …", #1797) checks the size model against C's layout and round-trips a `Box` of such a struct. The seed-built stage-1 of this branch, with the boxed field, passes `check ./src` and the origins corpus.
