# `GlobalAllocator.aligned_alloc` ships with no `aligned_free`, so the only pairing available corrupts the heap on Windows

**Found**: 2026-09-04, by the std-API-audit coverage read —
`GlobalAllocator.aligned_alloc` is one of the exported names that no test under
`tests/` ever mentions, and reading it against the codegen side shows std never
exposes the matching free. **Class**: memory-unsafety (Windows/MSVC targets).
**Status**: OPEN.

## Symptom

`std/allocator.yo:33-46` declares five allocator externs and
`std/allocator.yo:48-62` exports five names:

```rust
GlobalAllocator :: impl({
  malloc :: __yo_malloc;
  calloc :: __yo_calloc;
  realloc :: __yo_realloc;
  free :: __yo_free;
  aligned_alloc :: __yo_aligned_alloc;
  export(malloc, calloc, realloc, free, aligned_alloc);
});
```

There is no `aligned_free`: `grep -rn 'aligned_free' std --include='*.yo'` is
empty. A user who calls `GlobalAllocator.aligned_alloc` has exactly one way to
release the block — `GlobalAllocator.free`, i.e. `__yo_free`.

Codegen, meanwhile, knows the two are **not** interchangeable. `emit_c_includes`
(`src/codegen/c/collection.yo:110-166`) defines a separate `__yo_aligned_free`
for every allocator configuration:

| configuration | `__yo_aligned_alloc` | `__yo_aligned_free` |
| --- | --- | --- |
| mimalloc present | `mi_aligned_alloc` | `mi_free` |
| POSIX, system allocator | `aligned_alloc` | `free` |
| **Windows, system allocator or mimalloc fallback** | `_aligned_malloc(size, alignment)` | **`_aligned_free`** |

Only the Windows rows differ, and those are the rows std gets wrong. MSVC's
`_aligned_malloc` blocks must be released with `_aligned_free`; passing one to
`free` is undefined behaviour and corrupts the CRT heap.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ GlobalAllocator } :: import("std/allocator");
{ aligned_alloc, free } :: GlobalAllocator;
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  p := unsafe(aligned_alloc(usize(64), usize(256)));
  match(
    p,
    .Some(q) => {
      unsafe(free(.Some(q)));
      println("aligned_alloc block released with GlobalAllocator.free");
    },
    .None => println("alloc failed")
  );
});
export(main);
```

This is the only code a user can write — there is no other free to call.

`yo compile … --emit-c --skip-c-compiler --target x86_64-pc-windows-msvc`
produces:

```c
#define __yo_free free
static inline void* __yo_aligned_alloc(size_t alignment, size_t size) { return _aligned_malloc(size, alignment); }
#define __yo_aligned_free _aligned_free
…
  void* _file____priv_temp_9303 = __yo_aligned_alloc(64ULL, 256ULL);
  void* p = _file____priv_temp_9303;
  if (p != NULL) {
    void* q = p;
    void* _file____priv_temp_9304 = q;
    __yo_free(_file____priv_temp_9304);
```

i.e. `free(_aligned_malloc(256, 64))`. `__yo_aligned_free` is defined three
lines above and is unreachable from Yo. On macOS the same program emits
`#define __yo_aligned_alloc aligned_alloc` / `#define __yo_aligned_free free`
and runs clean — which is why nothing in the tree has ever noticed.

Expected: an `aligned_free` on `GlobalAllocator` that lowers to
`__yo_aligned_free`, so the emitted C is `_aligned_free(...)` on Windows and
`free(...)` on POSIX.

## Root cause

`std/allocator.yo:33-46`. The extern block was written with five entries and
`__yo_aligned_free` was never added, even though `src/codegen/c/collection.yo`
emits it under all four branches (lines 122, 130, 133, 144, 147, 159 and 162, across the
mimalloc / `__has_include`-fallback / system-allocator paths). Nothing forces
the two lists to agree — the C macro is defined whether or not any Yo name binds
it, so the omission is silent.

It has never been caught because `aligned_alloc` has no in-tree consumer either.
The only importer is `std/collections/array_list.yo:6`, which pulls the name in
its `{ malloc, calloc, realloc, free, aligned_alloc } :: GlobalAllocator;`
destructuring and then never uses it (`grep -c aligned_alloc
std/collections/array_list.yo` → 1, the import line). It is named in no test.

## Fix

Additive, three lines plus a test:

1. `std/allocator.yo:33-46` — add
   `__yo_aligned_free : (fn(ptr : ?*void) -> unit)` to the `extern("Yo", …)`
   block.
2. `std/allocator.yo:48-62` — add `aligned_free :: __yo_aligned_free;` and list
   `aligned_free` in the impl's `export(...)`.
3. Document the pairing on both members: a block from `aligned_alloc` **must**
   be released with `aligned_free`, never with `free`, and vice versa.

No codegen change is needed — `__yo_aligned_free` already exists in every
emitted header.

Because this is additive it must land **before** the S5 export freeze
(`plans/STD_API_AUDIT.md` §9); after the freeze, the broken pairing is frozen in
and the only remaining option would be a breaking removal of `aligned_alloc`.

The alternative — **delete `aligned_alloc`** as a zero-consumer export under
§6 — is defensible on dead-surface grounds, but it removes the only way for a
user to get over-aligned memory (SIMD buffers, cache-line-aligned ring buffers),
which is a real need with a C counterpart already emitted. Recommend adding the
free, not deleting the alloc.

## Regression test

`tests/allocator.test.yo` (which today covers only `size_would_overflow` and
`layout_of`):

- `aligned_alloc / aligned_free round-trip` — allocate 256 bytes at alignment
  64, assert the returned pointer is `.Some`, assert
  `usize(ptr) % usize(64) == usize(0)`, write and read back a byte through it,
  then release it with `aligned_free`. This runs on every platform and is the
  test that would have failed to *compile* before the fix, because
  `aligned_free` did not exist.

The Windows leg is the one that matters for the corruption, and it is also the
riskiest to bring up — see `issues/retired-windows-vcpkg-capability.md` and
`issues/windows-no-main-worker-stack-rc139.md` for the live hazards there. Do
not skip the test on Windows: the whole point is that the Windows leg is the
broken one.
