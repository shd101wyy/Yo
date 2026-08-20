# Windows uses the system allocator on both targets

**Decision, 2026-08-20 (user).** Windows release bundles are built with
`--allocator system` on **both** `windows-x64` and `windows-arm64`.
Linux keeps mimalloc. macOS already used `system`.

Recorded because the decision is **not** "mimalloc was broken so we removed it".
On x64 mimalloc worked. It was removed for consistency, and this file exists so
that a future reader does not rediscover the working x64 build and assume the
change was a mistake.

## Where each platform stands after this

| target | allocator | why |
| --- | --- | --- |
| linux-x64, linux-arm64 | **mimalloc** | glibc malloc inflates the emit's peak RSS ~72% (15.5 GB vs 9.0 GB). Measured, platform-specific, and does not transfer. |
| macos-arm64, macos-x64 | system | mimalloc measured **slower and fatter** on macOS — 3.3x on markdown_it_yo, +53% wall on the r15 self-emit. |
| windows-x64 | system | this decision — see below |
| windows-arm64 | system | this decision, and mimalloc cannot be built there at all |

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

## The cost, stated honestly

**Unmeasured on Windows, and knowingly accepted.** There has never been an
allocator A/B on a Windows runner, and until 2026-08-20 there was no
peak-memory measurement of any kind there — the sampler's Windows arm in
`test.yml` was literally `Windows) : ;;`, inside a step gated
`if: runner.os == 'Linux'`.

`.github/workflows/ab-windows-allocator.yml` and
`scripts/bootstrap/measure-windows.ps1` now exist and can quantify what was
given up. That measurement is no longer a blocker for anything — it is
informational.

The other cost of the alternative is worth restating: keeping mimalloc on x64
would have pinned the submodule to v3.3.2, since v3.5.0 does not compile there.

## How to revisit

The decision is one matrix field per target in `.github/workflows/release.yml`
(`bundle_allocator` in `seed-cross-emit`). The link line follows automatically:
the emit job writes `cross/allocator-<target>.txt` and the native compile reads
it, so the emit and the link cannot drift.

Reopen this if any of the following changes:

1. The Windows A/B shows mimalloc materially ahead on wall or peak.
2. Upstream mimalloc adds a `__clang__` discriminator to `atomic.h`, making the
   C11 route viable on ARM64. It had none as of v3.5.0 and the tips of
   `main`/`dev`/`dev3` (checked 2026-08-20).
3. The portable single-file `yo.c` constraint is dropped, which would put the
   C++ route back on the table.

## Related

- `issues/windows-arm64-mimalloc-msvc-arm-intrinsics.md` — the original arm64 break
- `issues/windows-arm64-emitted-c-state-machine-pointer-mismatch.md` — a SEPARATE
  defect in Yo's own emitted C. windows-arm64 stays `experimental: true` because
  of it; the allocator change does not touch it.
- `issues/fixed/mimalloc-performance-regression.md` — the macOS measurements
