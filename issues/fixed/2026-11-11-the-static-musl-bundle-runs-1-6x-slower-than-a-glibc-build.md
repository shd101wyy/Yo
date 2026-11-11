# The static musl bundle runs 1.6x slower than a glibc build of the same C

**Severity:** S2. Every Linux user runs the static musl bundle (`yo-v*-linux-*-musl`), and v0.2.76's bundle
built the compiler in 33:12 where a glibc build of the same source took 20:16 (1.64x). Nothing was
wrong in the output; the cost was every command's wall time.

- Filed and fixed: 2026-11-11 (musl-perf lane; Fable consult `VERDICTS-56`).
- Fix: `scripts/musl-compile.sh` is now the one copy of the musl compile recipe. It builds with
  `clang -O2 -U_FORTIFY_SOURCE` and, on x86_64, links `scripts/musl-fastmem.c` ahead of `libc.a`.
  `release.yml`'s two musl-bundle compile steps and `test.yml`'s musl leg all call it.

## Measurement

The input was one emitted C file: the v0.2.76 tree, `--allocator mimalloc`, seed-emitted, 138 MB.
It was compiled seven ways. The workload was `check ./std/collections --std-path ./std`, which is
single-threaded and reproduces the full-build ratio: 50.5 s on glibc and 82.9 s on the released
bundle. All seven binaries ran concurrently, so machine load hit them all alike. Times are wall
seconds:

| Binary                                                          | Round 1 | Round 2 |
| --------------------------------------------------------------- | ------: | ------: |
| Alpine clang -O2 static, `-U_FORTIFY_SOURCE`, `musl-fastmem.o`  |    54.2 |    58.3 |
| glibc build (host clang 21; the binary measured at 20:16)       |    58.7 |    61.4 |
| host clang -O2, glibc                                           |    58.8 |    59.4 |
| Alpine clang -O2 static, `-U_FORTIFY_SOURCE`                    |    60.7 |    67.0 |
| Alpine gcc -O2 static, `-U_FORTIFY_SOURCE`                      |    62.9 |    70.6 |
| the release recipe (Alpine gcc -O2 static)                      |    81.8 |    99.7 |
| Alpine clang -O2 static (fortify on)                            |    82.0 |    94.5 |

Compiling the 138 MB translation unit inside Alpine cost different amounts of time and memory per
recipe. This matters on the 16 GB release runners:

| Recipe                       |  Time | Peak RSS |
| ---------------------------- | ----: | -------: |
| gcc (the old recipe)         | 13:41 |  17.9 GB |
| gcc `-U_FORTIFY_SOURCE`      | 17:42 |  15.0 GB |
| clang `-U_FORTIFY_SOURCE`    | 12:16 |   8.0 GB |

## Root cause

The compiler family was not the cause: switching to clang alone gained 4%. Two Alpine defaults
caused the slowdown.

1. **fortify-headers.** Alpine's `cc` and `clang` both predefine `_FORTIFY_SOURCE=2` at `-O2`
   (`echo | cc -O2 -dM -E -`), and that switches on fortify-headers. Its inline `memcpy` wrapper
   traps when the source and destination overlap. That check runs on every `memcpy`, including the
   tens of thousands of fixed-size `// Save old value by bytes` copies in the emitted C, so their
   temporaries live on the stack behind a compare and a branch. The clang-built binary carried
   6993 `ud2` traps; the glibc build carries none. glibc's fortify uses `__memcpy_chk`, which folds
   away when the size is known, so the glibc build paid nothing. In the profile, the SipHasher
   `write_u8`/compress functions took 12.9% of samples out of line on musl and were inlined on
   glibc.
2. **musl's string functions.** musl's x86_64 `memcpy` is a `rep movsq` loop, and its `memcmp` is a
   byte loop. The released bundle spent 10.6% of its samples in `memcpy`, against 2.9% for glibc's
   `__memmove_avx512_unaligned_erms`. To isolate this, musl's `memcpy`/`memmove`/`memcmp` were
   `LD_PRELOAD`ed into the glibc build. That build slowed from 56.6 s to 63.6 s, or 12%.

The C compile of the old recipe also peaked at 17.9 GB, which forced the release runners into swap.

## Fixed

`scripts/musl-compile.sh` with recipe `fast`, the default, does the following:

- It builds with `clang -U_FORTIFY_SOURCE`, and asserts that clang's predefines no longer carry
  `_FORTIFY_SOURCE`.
- On x86_64 only, it compiles `scripts/musl-fastmem.c` on its own with `-fno-builtin`. That file
  provides `memcpy`/`memmove` built on overlapping 16-byte loads (baseline SSE2) and an 8-byte-word
  `memcmp`. `memcpy` has `memmove` semantics because fortify used to trap overlap. The script
  asserts that the object references no `mem*` symbol. It then runs `scripts/musl-fastmem-test.c`,
  an exhaustive check against byte-loop references, against that same object, links the object,
  and asserts that musl's `__memcpy_fwd` did not make it into the binary.
- aarch64 keeps musl's assembly `memcpy`.

The `musl_recipe` input of `release.yml` can select `legacy-arm64` (old recipe on arm64) or `legacy`
(old recipe on both). It exists for rollback only and is deleted in v0.2.78. GCC still reads the
emitted C in `test.yml`'s musl leg, through `gcc -std=c11 -fsyntax-only`.

The regression guards are these. The fortify-predefine assert, the `nm` asserts and the fastmem
test all run inside `scripts/musl-compile.sh`, in every develop battery and in the release. The
fastmem test fails on a deliberately broken `memmove`, which was checked when the test was written.

Related, still open: Yo programs compiled on Alpine pay the same fortify cost,
`issues/2026-11-11-alpine-fortify-headers-slow-every-yo-program-compiled-on-alpine.md`.
