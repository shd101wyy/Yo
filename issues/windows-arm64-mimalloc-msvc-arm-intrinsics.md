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

---

## RESOLUTION (2026-08-20): `--allocator system` for windows-arm64

Fix option 1 was taken, and the investigation upgraded it from "cheapest" to
"the only correct one". Options 2 and 3 are now positively ruled out, not merely
deprioritised.

### Upstream has NO source fix, and will not

The vendored mimalloc is upstream tag **v3.3.2**
(`30b2d9d89099bee08e9f67a1ffb3e12e7ba45227`, `MI_MALLOC_VERSION 30302`), clean,
no local modifications. The `_M_ARM64` blocks in `include/mimalloc/atomic.h` are
**byte-identical** at the newest tag (v3.5.0) and at the tips of `origin/main`,
`origin/dev` and `origin/dev3` (tip `604c252a`, 2026-08-19). `__clang__` appears
**zero** times in that file.

Upstream's mitigation is not a source guard at all but a BUILD-SYSTEM one:
commit `d767dbfb` sets `MI_USE_CXX=ON` for clang-cl in CMakeLists.txt, routing
clang to the `#if defined(__cplusplus)` `std::atomic` path and skipping the MSVC
C wrapper entirely. **That commit is already in v3.3.2** — but Yo bypasses
mimalloc's CMake, handing `vendor/mimalloc/src/static.c` to clang as plain C
(`src/main.yo:1527`, `release.yml` `-std=c11`), so the mitigation never engages.

### A one-line guard fix is NOT sufficient

There are **four** `__ldar64`/`__stlr64` call sites, not the two visible at
:277/:302 — `MI_MSC_XX(f)` is `f##64` on `_WIN64`, so :234 and :256 expand to the
same missing symbols. (4 intrinsic sites + `init.c:446` reconciles exactly with
the "5 errors generated" in the log.) Worse, those two sit under an `#elif`
whose `#else` fallback is a **relaxed load mislabelled as acquire** — so they
cannot simply be excluded without introducing a memory-ordering bug. Patching
this correctly means either the C11-stdatomic route (3 edits, unverified on
Windows ARM64) or compiling `static.c` as C++ (pulls in msvcprt, which the
current link line does not provide).

Carrying such a patch also has no precedent here: the only vendored-dependency
pin in the repo is `markdown_yo`, a Yo-source dep the maintainer controls.

### Why `system` is a good outcome regardless

`system` is the compiler's own CLI default (`src/main.yo:956`), and the one
platform where the two allocators were ever measured — macOS — flipped to
`system` because mimalloc was **slower and fatter** (3.3x on markdown_it_yo,
+53% wall on the r15 self-emit).

## Two further defects found while fixing this

### 1. `seed-cross-emit` was UNPROTECTED — a latent release-killer

windows-arm64 is built by TWO legs, and only one was guarded:

| job | protection |
| --- | --- |
| `seed-bundles-cross` (native compile) | `continue-on-error: ${{ matrix.experimental }}` |
| `seed-cross-emit` (Yo -> C) | **none** |

`seed-cross-emit` feeds `portable-c`, which feeds `publish-release`. A failure
in the windows-arm64 cross-emit leg would therefore have left the release an
**unpublished draft**. v0.2.12 survived only because the failure happened to land
in the protected native-compile leg. Fixed by giving that job the same
`experimental` flag. Safe: `scripts/make-portable-c.sh` requires only
`linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64` —
windows-arm64 is not one of its arms.

### 2. Nothing ever verified the Windows bundle LINKS mimalloc

The emitted mimalloc block is `#if __has_include(<mimalloc.h>)` with a
malloc/free `#else`. A build that asks for mimalloc but is compiled without the
include path therefore **compiles, links, runs and smoke-tests green while
quietly using the CRT heap** — the mis-link degrades silently instead of
failing. No Windows leg has ever asserted otherwise, so whether the shipped
windows-x64 bundle actually contains mimalloc is **unverified to date**.

Two changes close this: the allocator now travels WITH the C as
`cross/allocator-<target>.txt` (one source of truth, so the emit and the link
cannot drift), and a new assertion greps the built `.exe` for `mi_*` symbols and
fails if they disagree with what was requested.

**Watch the next release:** if windows-x64 has been silently falling back, that
assertion will fail it. That is a true positive worth having.
