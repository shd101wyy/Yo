> **RETIRED 2026-08-20.** Root-caused and superseded by
> `issues/async-cond-shared-await-point-only-models-representative-branch.md`.
> Two claims below did not survive: the defect is NOT arm64-specific (the x64
> emit carries the byte-identical class — arm64 merely compiles with clang 22,
> where the diagnostic is a default error), and v0.2.12's arm64 emit was NOT
> clean of it (its log died at mimalloc before reaching these sites).

# windows-arm64 emitted C: async state-machine pointer types crossed between temp-file modules

**Status:** OPEN, not yet root-caused. Surfaced 2026-08-20 by
`.github/workflows/ab-windows-allocator.yml` run 32348332689 (job
`Q2: can mimalloc build on windows-arm64 via the C++ route?`).

This is a **separate defect** from
`issues/windows-arm64-mimalloc-msvc-arm-intrinsics.md`. That one is in vendored
mimalloc. This one is in **Yo's own emitted C**.

## Symptom

Compiling the cross-emitted `aarch64-windows-msvc` C fails with five
`-Wincompatible-pointer-types` errors, all of the same shape — one async
state-machine struct pointer assigned from a *different* state-machine struct
pointer:

```
cross/yo-windows-arm64.c:2238639:34: error: incompatible pointer types assigning to
  '_file____home_temp_8543_state_t *'   (aka 'struct _file____home_temp_8543_state_t_struct *')
  from '_file____home_temp_8574_state_t *'
cross/yo-windows-arm64.c:2253434:34: error: ... 8543 <- 8574
cross/yo-windows-arm64.c:2257475:34: error: ... 1354819 <- 1355141
cross/yo-windows-arm64.c:2257545:38: error: ... 1354819 <- 1354997
cross/yo-windows-arm64.c:2263953:30: error: ... 7930 <- 7950
```

Note `-w` is on the command line and does not suppress these: clang promoted
`-Wincompatible-pointer-types` to a default *error* in recent versions.

## What is and is not implicated

| | |
| --- | --- |
| windows-**x64** emitted C | **CLEAN** — both arms of the same run linked with no errors |
| windows-**arm64** emitted C | 5 errors |
| v0.2.12's release emit of windows-arm64 | **CLEAN** of this class |

The v0.2.12 point matters and is not an inference from absence: in that run
(job 96335309059) `cross/yo-windows-arm64.c` was the FIRST input on the clang
command line, so its diagnostics would have printed before mimalloc's. The log
shows only the 5 mimalloc/init.c errors. So this C compiled clean there.

## Two candidate causes, not yet discriminated

1. **A regression in `develop` since the v0.2.12 tag.**
2. **Seed-emit vs candidate-emit.** `release.yml` builds a *candidate* compiler
   from the released commit and has THAT emit the bundle C; the A/B workflow
   emits directly with the **seed** binary. Different compiler generations
   producing different C is exactly the kind of difference this would expose.

Cause 2 is cheap to test and should be tested first: build a candidate the way
release.yml does, re-emit `aarch64-windows-msvc`, and see whether the errors
persist.

## The lead worth pulling

The struct names are derived from **temp file paths** — `_file____home_temp_8543_state_t`
looks like `/home/.../temp/8543`. So each async state machine is keyed by a
per-file mangled name, and two *different* files' state types are being assigned
across. Numerically the pairs are adjacent (8543/8574, 1354819/1355141,
7930/7950), which suggests two modules emitted close together in the same run
rather than an arbitrary collision.

Compare `issues/module-global-c-names-are-not-namespaced.md` (same family:
identity derived from a name that is not unique enough) and
`memory: yo-self-enum-codegen-identity-dedup`.

## Why it was invisible until now

Nothing compiles the windows-arm64 C except the release's own bundle leg, and
that leg died earlier — at mimalloc — on the only release that ever ran it. The
A/B workflow compiles the same C by a different route (`-x c++` for mimalloc,
so the mimalloc errors move out of the way), which let the next error class
become visible.

## Consequence

`--allocator system` unblocks the mimalloc half of the windows-arm64 bundle but
**does not** make the leg green: this defect is upstream of the allocator
choice. The leg must stay `experimental: true` until this is fixed.
