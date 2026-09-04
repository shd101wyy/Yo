# Windows uses the system allocator on both targets

**Decision, 2026-08-20 (user).** Windows release bundles are built with
`--allocator system` on **both** `windows-x64` and `windows-arm64`.
Linux keeps mimalloc. macOS already used `system`.

> **2026-09-04 update — revisited, measured on Windows, RE-AFFIRMED.** Both
> grounds of the original decision were re-tested by PR #181:
>
> 1. *Buildability.* The vendored v3.5.1 bump removed the hard blocker:
>    upstream fixed the clang-cl `__ldar64`/`__stlr64` gap (arm64) and the
>    v3.5.0 x64 pointer-type breakage, so `--allocator mimalloc` now builds
>    and runs on both Windows targets as plain C11 under clang — no local
>    patches, no C++ route (`issues/fixed/
>    windows-arm64-mimalloc-msvc-arm-intrinsics.md`). The per-PR Windows
>    native suite legs (`test.yml` `test-native`) compile and run it on both
>    arches, so the option stays CI-guarded for Windows users who pick it.
> 2. *Cost.* The Windows A/B this file originally lacked now exists —
>    measured 2026-09-04 on a windows-x64 host (clang 21.1.8, stage-1 twins
>    built by the same seed from the same tree, 3 reps per arm,
>    min-of-reps, `scripts/bootstrap/measure-windows.ps1`), on the two
>    canonical heavy workloads rather than the 2026-08-20 `check ./std`
>    probe: **system is ~25% faster on `check ./src` and ~28% faster on the
>    full-tree emit, with non-overlapping spreads**; mimalloc is
>    consistently leaner on peak. The macOS pattern reproduces on Windows.
>    **`system` stays** (user, 2026-09-04) — see "The cost" below for the
>    full tables.

Recorded because the decision is **not** "mimalloc was broken so we removed it".
On x64 mimalloc worked. It was removed for consistency, and this file exists so
that a future reader does not rediscover the working x64 build and assume the
change was a mistake.

## Where each platform stands after this

| target | allocator | why |
| --- | --- | --- |
| linux-x64, linux-arm64 | **mimalloc** | glibc malloc inflates the emit's peak RSS ~72% (15.5 GB vs 9.0 GB). Measured, platform-specific, and does not transfer. |
| macos-arm64, macos-x64 | system | mimalloc measured **slower and fatter** on macOS — 3.3x on markdown_it_yo, +53% wall on the r15 self-emit. |
| windows-x64 | system | re-measured 2026-09-04: system ~25% faster on wall (check, emit), mimalloc leaner on peak — see "The cost" |
| windows-arm64 | system | same decision and evidence as x64 (no arm64 Windows host has run the A/B); mimalloc v3.5.1 builds there now and is CI-exercised per-PR |

## The two Windows targets were NOT the same question

This is the part worth being precise about, because "Windows can't use mimalloc"
is false as stated.

**windows-arm64 genuinely cannot build it.** mimalloc's `atomic.h` selects its
intrinsic family by ARCHITECTURE (`_M_ARM64`) with no compiler discriminator,
and clang defines `_M_ARM64` for MSVC source compatibility while implementing
neither `__ldar64` nor `__stlr64`.

**windows-x64 built it fine, and shipped it.** Measured against the released
artifact, not inferred:

| binary | size | `"mimalloc: "` literals |
| --- | --- | --- |
| shipped `yo-v0.2.12-windows-x64` `yo.exe` | 8,171,008 B | 2 |
| same source, `--allocator system` | 7,881,216 B | 0 |

The 289,792-byte delta is the mimalloc code, and the mimalloc build also ran
(`check ./std` completed under it). So x64 was a **working configuration that
was given up**, not a broken one that was fixed.

### Why clang manages x64 but not arm64

Not a difference in mimalloc's logic — a difference in clang's MSVC-intrinsic
coverage. Probed directly:

```
$ clang --target=x86_64-pc-windows-msvc  -std=c11 -fsyntax-only  # _InterlockedExchange64
error: call to undeclared LIBRARY function '_InterlockedExchange64' ...
note: include the header <intrin.h> or explicitly provide a declaration

$ clang --target=aarch64-pc-windows-msvc -std=c11 -fsyntax-only  # __ldar64
error: call to undeclared function '__ldar64' ...        <- no note, no suggestion
```

Clang **knows** `_InterlockedExchange64` and merely wants the declaration, which
mimalloc gets from `<intrin.h>`. It does not know `__ldar64` at all — not a
builtin, and not declared by clang's `<intrin.h>`. Clang's MSVC-intrinsic
surface is complete for x86/x64 (the dominant MSVC-compat target) and
incomplete for ARM64. MSVC itself compiles both.

## What was rejected, and why

| option | verdict |
| --- | --- |
| patch `atomic.h`'s guard to exclude clang | 4 call sites, not 2 — `MI_MSC_XX(f)` is `f##64` on `_WIN64`. Two sit under an `#elif` whose `#else` is a **relaxed load mislabelled acquire**, so excluding them trades a build error for a memory-ordering bug. |
| upgrade mimalloc | **worse.** v3.5.0 breaks windows-**x64** too (`internal.h:792`, `return mi_atomic_load_acquire(&page->self)` returning `uintptr_t` as `mi_page_t*`), which v3.3.2 does not. |
| compile `static.c` as C++ (`-x c++`) | **works** — measured; it removes the `__ldar64`/`__stlr64` errors. **Rejected by policy:** it pulls in the MSVC C++ runtime and would break the portable single-file `yo.c`, whose entire purpose is bootstrapping with nothing but a C compiler. C11 is the only build route. |
| use `cl.exe` for the Windows legs | rejected: the bundle pipeline is clang end to end, and one structurally different leg is a maintenance trap. |

## The underlying mismatch

Yo compiles mimalloc as **plain C11**. Clang defines `_MSC_VER` and `_M_ARM64`
for MSVC source compatibility, so it takes mimalloc's **MSVC-C** path — which
upstream does not exercise under clang, because upstream's own CMake compiles
mimalloc as C++ there (`MI_USE_CXX`, commit `d767dbfb`, already present in
v3.3.2 but inert for us since we bypass CMake).

We are using a route upstream does not support, and the evidence is that it is
decaying rather than stabilising: v3.3.2 broke arm64, v3.5.0 broke x64 as well.
Keeping mimalloc on Windows therefore meant pinning it indefinitely and
absorbing each new break.

## The cost: measured, and it is not a cost

The A/B finally ran clean on 2026-08-20 (run 32355228818, `windows-latest`,
`check ./std`, 3 reps per arm, min-of-reps):

| arm | min wall | spread | min peak |
| --- | --- | --- | --- |
| mimalloc | 31.96 s | 0.26 s | 1,657 MB |
| system | 32.74 s | 2.78 s | 1,566 MB |

Wall: −2.4% for mimalloc, but the 0.78 s delta sits INSIDE the system arm's
own 2.78 s run-to-run spread — the workflow's own guard refuses to call a wall
winner. Peak: mimalloc is **+5.8% fatter** (91 MB). So on Windows the switch
to the system allocator gave up nothing measurable and saved memory — nothing
like Linux glibc's 72% peak inflation, which remains the only platform where
mimalloc pays its way.

(Before this run there had NEVER been a peak-memory measurement on a Windows
runner — the sampler's Windows arm in `test.yml` was literally `Windows) : ;;`
inside a step gated `if: runner.os == 'Linux'`.)

The other cost of the alternative is worth restating: keeping mimalloc on x64
would have pinned the submodule to v3.3.2, since v3.5.0 does not compile there.

### Re-measured on the real workloads (2026-09-04): system wins wall decisively

The 2026-08-20 probe ran `check ./std` — a toy next to what yo.exe actually
does. Once the v3.5.1 bump made mimalloc buildable again, the A/B was re-run
on the two canonical heavy workloads. Same method (stage-1 twins built by the
same seed from the same tree, 3 reps per arm, min-of-reps, peak sampled
in-loop at 200 ms):

`yo check ./src --std-path ./std` (evaluator-bound):

| arm | min wall | spread | min peak |
| --- | --- | --- | --- |
| mimalloc v3.5.1 | 455.58 s | 37.18 s | 13,391 MB |
| system | 340.10 s | 11.65 s | 15,447 MB |

full-tree emit (`compile src/main.yo --optimize 2 --emit-c --skip-c-compiler`,
the CI/release hot path):

| arm | min wall | spread | min peak |
| --- | --- | --- | --- |
| mimalloc v3.5.1 | 511.88 s | 12.94 s | 12,823 MB (reps ranged 12.8–16.3 GB) |
| system | 368.74 s | 68.70 s | 18,490 MB (flat across reps) |

Wall: mimalloc is **+34% slower on check and +39% slower on the emit**
(equivalently, system is 25%/28% faster), and both comparisons are
unambiguous — the arms' spreads do not overlap; system's WORST emit rep
(437 s) beats mimalloc's BEST (512 s). The macOS pattern reproduces: mimalloc
v3's abandoned-page reclaim-on-free path costs more than the platform default
saves for this compiler's allocation pattern, on Windows as on macOS.

Peak: the one dimension mimalloc wins — 13% leaner on check, and on the emit
12.8–16.3 GB against system's flat 18.5 GB. A real trade, and the reason
mimalloc still pays its way on Linux; but wall time is what the release
pipeline, CI, and every `yo build` pay, so the decision re-affirms `system`
(user, 2026-09-04). Windows now keeps `system` not for lack of measurement
but because of it.

(Tooling note: the sampler's original post-exit `PeakWorkingSet64` read
silently stopped working on modern .NET — it returns empty once the child
exits, even with the handle cached. `scripts/bootstrap/measure-windows.ps1`
now samples the peak in a 200 ms wait loop; the numbers above are from that
version.)

## How to revisit

The decision is one matrix field per target in `.github/workflows/release.yml`
(`bundle_allocator` in `seed-cross-emit`). The link line follows automatically:
the emit job writes `cross/allocator-<target>.txt` and the native compile reads
it, so the emit and the link cannot drift.

Reopen this if any of the following changes:

1. RESOLVED 2026-09-04, against flipping: the A/B ran and system is
   materially ahead on wall (see "The cost"). Reopen only if a workload
   appears where peak RSS is the binding constraint AND the measured wall
   regression is acceptable.
2. RESOLVED by v3.5.1: upstream added the `__clang__` discriminators
   (PRs #1379/#1380), making the C11 route viable on ARM64. No longer a
   differentiator — the arm64 build works and is CI-exercised.
3. The portable single-file `yo.c` constraint is dropped, which would put the
   C++ route back on the table. (Moot for allocator choice while `system`
   wins wall anyway.)

## Related

- `issues/fixed/windows-arm64-mimalloc-msvc-arm-intrinsics.md` — the original arm64 break (fixed upstream in v3.5.1; was retired as mooted by this decision, restored to `issues/fixed/` by the v3.5.1 bump)
- `issues/fixed/async-cond-shared-await-point-only-models-representative-branch.md` — a SEPARATE
  defect in Yo's own emitted C. windows-arm64 stays `experimental: true` because
  of it; the allocator change does not touch it.
- `issues/fixed/mimalloc-performance-regression.md` — the macOS measurements
- `scripts/bootstrap/measure-windows.ps1` — the A/B tool (restored 2026-09-04
  with in-loop peak capture; `check ./src`/emit numbers above are its output)
