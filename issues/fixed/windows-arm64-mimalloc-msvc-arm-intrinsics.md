# windows-arm64 bundle fails: vendored mimalloc uses MSVC-only ARM64 intrinsics under clang

**Status:** FIXED 2026-09-04 — see "RESOLVED BY UPSTREAM v3.5.1" at the bottom.
The fix is the vendored-mimalloc v3.5.1 bump, not a local patch; the record
below is kept because the constraints it establishes (plain-C11 build route,
no C++ runtime) still govern how mimalloc may be upgraded. Formerly
`issues/retired/`, where it had been filed as mooted by the 2026-08-20
system-allocator decision; the v3.5.1 bump PR (#181) moved it to
`issues/fixed/` when an actual fix landed. Originally filed as: Found by the
first release that exercised the leg (v0.2.12,
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

### IMPORTANT correction: mimalloc DOES support Windows ARM64

An earlier revision of this doc and of the release.yml comment said mimalloc
"cannot be compiled for arm64-Windows by clang at all". That is **wrong** and is
corrected here. Upstream supports the platform. The failure is narrower:

| route | works? |
| --- | --- |
| MSVC (`cl.exe`) | YES — the `__ldar64`/`__stlr64` intrinsics exist there |
| clang-cl with `MI_USE_CXX=ON` | YES — upstream's own mitigation |
| clang, `static.c` as C++ (`-x c++`) | PLAUSIBLE, untested — the same thing by hand |
| **clang, `static.c` as plain C11** | **NO — this is Yo's route, and what broke** |

The open risk on the C++ route is the LINK, not the compile: C++ pulls in the
MSVC C++ runtime, which the current `-lws2_32 -lbcrypt -ladvapi32` line does not
provide. `.github/workflows/ab-windows-allocator.yml` probes it directly
(job `probe-arm64-cxx`, Route B).

`system` remains the right immediate choice because it is the only route PROVEN
to build today, it is the compiler's own default, and macOS measured mimalloc
slower and fatter. But it is an unblock pending evidence, not a verdict that
mimalloc is impossible here.

### Upstream had no source fix UNTIL v3.5.1 (but had a BUILD-SYSTEM one)

The vendored mimalloc was upstream tag **v3.3.2**
(`30b2d9d89099bee08e9f67a1ffb3e12e7ba45227`, `MI_MALLOC_VERSION 30302`) when
this was investigated, clean and unmodified. At v3.5.0
(`18b08671c9302247bfb682286e6bf3cc1773f801`, `MI_MALLOC_VERSION 30500`) the
bump still changed NOTHING here — the `_M_ARM64` guard blocks were
byte-identical between the two tags, and `__clang__` appeared **zero** times
in `atomic.h` at `origin/main`, `origin/dev` and `origin/dev3` (tip
`604c252a`, 2026-08-19). **That stopped being true at v3.5.1** — see
"RESOLVED BY UPSTREAM v3.5.1" below; the sentences above describe the state
as of the 2026-08-20 investigation.

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


---

## CLOSED 2026-08-20: Windows uses the system allocator on both targets

**User decision. Full record: `plans/WINDOWS_ALLOCATOR_DECISION.md`** — read that
rather than this section for the reasoning, the rejected alternatives, and the
conditions for revisiting.

Rather than fix mimalloc for arm64, Windows stops using mimalloc at all —
`bundle_allocator: system` for windows-x64 and windows-arm64. Note x64 was a
WORKING configuration that was given up for consistency, not a broken one that
was fixed; the plan doc has the measured evidence.

### Why fixing it was the worse option

Every available fix was blocked or rejected:

| option | verdict |
| --- | --- |
| patch `atomic.h`'s guard | 4 call sites, and 2 sit under an `#elif` whose `#else` is a relaxed load mislabelled acquire — trades a build error for a memory-ordering bug |
| upgrade mimalloc | **makes it worse**: v3.5.0 breaks windows-**x64** too (`internal.h:792` `page->self`), which v3.3.2 does not |
| compile `static.c` as C++ (upstream's `MI_USE_CXX`) | WORKS — measured: it removes the `__ldar64`/`__stlr64` errors — but **rejected by policy**. It pulls in the MSVC C++ runtime and would break the portable single-file `yo.c`, whose whole purpose is bootstrapping with only a C compiler. C11 stays the only build route. |
| use `cl.exe` | rejected: the bundle pipeline is clang end to end |

### The underlying mismatch, stated plainly

Yo compiles mimalloc as plain C11. Clang defines `_MSC_VER` and `_M_ARM64` for
MSVC source compatibility, so it takes mimalloc's **MSVC-C** path — which
upstream does not exercise under clang, because upstream's CMake compiles
mimalloc as C++ for clang. We are using a route upstream does not support, and
the evidence is that the route is decaying rather than stabilising: v3.3.2 broke
arm64, v3.5.0 broke x64 as well.

`system` removes Windows from that dependency's blast radius entirely: no arm64
patch, no version pin, no C++ toolchain, and mimalloc upgrades stop being
Windows-blocked.

### Accepted cost

Unmeasured on Windows, knowingly. The only platform where the two were ever
compared is macOS, where mimalloc measured **slower and fatter** and macOS
flipped to `system` for that reason. A Windows A/B exists
(`.github/workflows/ab-windows-allocator.yml`) and can quantify what was given
up, but it is no longer a blocker.

**Linux is unaffected** and keeps mimalloc — glibc malloc inflates the emit's
RSS ~72%, which is a measured, platform-specific reason that does not transfer.

### Still open, and NOT fixed by this

`issues/fixed/async-cond-shared-await-point-only-models-representative-branch.md`. The arm64
leg has a second, unrelated defect in Yo's OWN emitted C. Switching allocator
does not touch it, so windows-arm64 stays `experimental: true`.

---

## RESOLVED BY UPSTREAM v3.5.1 (2026-09-04)

Upstream added exactly the source fix this file concluded did not exist. In
`include/mimalloc/atomic.h`, every `__ldar`/`__stlr`/`__ldar64`/`__stlr64`
call site is now guarded `!defined(__clang__)` — falling back to the
interlocked path clang DOES implement in MSVC-compat mode — with the memory
ordering preserved (the "relaxed mislabelled acquire" `#else` trap from
"A one-line guard fix is NOT sufficient" above is gone because upstream
restructured the guards rather than deleting the calls):

- `7cca1b54` — Work around clang-cl missing ldar, stlr (PR #1379, @res2k)
- `8cc8a2aa` — Allow C mode building w/ MSVC or clang-cl (PR #1380, @res2k)
- `604c252a`, `0a4ea88d` — clang-on-Windows compile/link fixes (issue #1370)
- the v3.5.0 windows-x64 breakage this file recorded (`internal.h` `page->self`
  returning `uintptr_t` as `mi_page_t*`) is fixed in the same release as
  `mi_atomic_load_ptr_acquire(mi_page_t, &page->self)` (`internal.h:800`)

Upstream also grew CI coverage for the exact route Yo needs — plain-C
(`MI_NO_USE_CXX`) clang-cl builds, including ARM (`0e9c24f8`, `d9626926`) —
so the "route upstream does not exercise" mismatch is exercised upstream now.

Verified locally against the vendored v3.5.1 with clang 21.1.8, plain C11, no
local patches, via `clang -std=c11 -fsyntax-only -Ivendor/mimalloc/include
vendor/mimalloc/src/static.c`:

| target | v3.3.2 | v3.5.0 | v3.5.1 |
| --- | --- | --- | --- |
| `x86_64-pc-windows-msvc` | builds | FAILS (pointer-type errors) | clean |
| `aarch64-pc-windows-msvc` | FAILS (`__ldar64`/`__stlr64`) | FAILS | clean |

`--allocator mimalloc` also builds and runs the full compiler natively on
windows-x64 again (see PR #181), and the windows-x64/windows-arm64 CI legs
compile it as part of the per-PR native suite.

What did NOT change: the shipped Windows bundles still use `--allocator
system` — that was a separate decision (`plans/WINDOWS_ALLOCATOR_DECISION.md`),
made on macOS-measured performance grounds, and only the "mimalloc cannot be
built here at all" part of its rationale is now obsolete.
