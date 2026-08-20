# windows-arm64 bundle fails: vendored mimalloc uses MSVC-only ARM64 intrinsics under clang

**Status:** OPEN. Found by the first release that exercised the leg (v0.2.12,
run 32336959494, job 96335309059). The leg is `experimental: true`, so the
release still concluded `success` and published — this is why that flag exists.

## What failed, and what did NOT

`Cross-emit C (windows-arm64)` **succeeded**. The compiler emits
`aarch64-windows-msvc` C correctly, and every one of the 5 errors is in
`vendor/mimalloc`, none in Yo's emitted C. This is a vendored-dependency
portability bug, not a codegen bug.

`Compile the cross-emitted C natively (Windows)` (step 6) failed:

```
vendor/mimalloc/include\mimalloc\atomic.h:277:14: error: call to undeclared
  function '__ldar64'; ISO C99 and later do not support implicit function
  declarations [-Wimplicit-function-declaration]
vendor/mimalloc/include\mimalloc\atomic.h:302:7: error: call to undeclared
  function '__stlr64'
vendor/mimalloc/src\init.c:446:47: error: incompatible pointer types passing
  'mi_heap_t **' to parameter of type 'const uintptr_t *'
5 errors generated.
```

The third error is downstream noise: with `mi_atomic_load_explicit` failing to
resolve, the macro expansion loses its type.

## Root cause

`vendor/mimalloc/include/mimalloc/atomic.h` selects the intrinsic family by
ARCHITECTURE with no COMPILER discriminator:

```c
#elif defined(_M_ARM) || defined(_M_ARM64)
    if (mo == mi_memory_order_relaxed) { ... }
    #if defined(_M_ARM64)
    else if (mo <= mi_memory_order_acquire) {
      return __ldar64((volatile const uintptr_t*)p);   // MSVC-only
    }
    #endif
```

`__ldar64` / `__stlr64` are `cl.exe` intrinsics. Clang targeting
`aarch64-windows-msvc` defines `_M_ARM64` **for MSVC source compatibility**
while providing neither intrinsic, so the guard steers clang into the MSVC path.
Note an outer `_MSC_VER` guard would NOT help — clang also defines `_MSC_VER`
in MSVC-ABI mode. The correct discriminator is `defined(__clang__)`.

**Why windows-x64 is unaffected:** it takes the `_M_IX86 || _M_X64` branch,
whose `_Interlocked*` intrinsics clang DOES implement in MSVC-compat mode. So
this is specific to ARM64 + clang, and could only ever have surfaced once a
windows-arm64 leg existed.

## Fix options, in order of preference

1. **Build this leg with `--allocator system`.** Sidesteps mimalloc entirely and
   unblocks the leg today. Cheap on merit too: `issues/fixed/mimalloc-performance-regression.md`
   and the r15/r16 allocator A/B both measured mimalloc SLOWER AND FATTER than
   the libc default for this workload, so dropping it here may be a small win.
   (`--allocator system` is the spelling as of the `libc`-alias deletion, #173.)
2. **Fix the guard** — `#if defined(_M_ARM64) && !defined(__clang__)`, or bump
   the vendored mimalloc to a release that already handles clang-on-ARM64.
   Correct upstream-wards, but this is a submodule, so it needs a fork or a
   patch step.
3. **Use `cl.exe` for this leg.** Rejected for now: the whole bundle pipeline
   assumes clang, and this would make one leg structurally different.

## Consequence for queued work

`plans/` has a queued item to run the language suite on windows-arm64 via
cross-emit. That stays BLOCKED until this leg produces an artifact — the
sequencing already agreed (promote only after one green run, per the
windows-x64 precedent at v0.2.1) is exactly right, and this failure is the
evidence for it.
