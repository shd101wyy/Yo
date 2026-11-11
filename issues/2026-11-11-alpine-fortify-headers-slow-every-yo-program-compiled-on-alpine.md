# Alpine's fortify-headers slow every Yo program compiled on Alpine

**Severity:** S3. A Yo program that `yo compile --optimize 2` builds on Alpine runs measurably slower
than the same program built on glibc. For the compiler itself the gap was about 40%.

Found 2026-11-11 by the musl-perf lane, while fixing
`issues/fixed/2026-11-11-the-static-musl-bundle-runs-1-6x-slower-than-a-glibc-build.md`. Targeted at
v0.2.78 (`VERDICTS-56` item 4).

## Cause

Alpine's `cc` and `clang` predefine `_FORTIFY_SOURCE=2` at `-O2`, and that switches on
fortify-headers. Its inline `memcpy` wrapper adds an overlap check and a trap to every call. The
emitted C calls `memcpy` for each `// Save old value by bytes` copy, a fixed-size copy of a scalar
into a fresh local, and there are tens of thousands of them in a large program. The checks keep
those temporaries on the stack. glibc's fortify (`__memcpy_chk`) folds away for known sizes, so the
same C pays nothing there.

The compiler's own bundle no longer pays this: its recipe builds with `-U_FORTIFY_SOURCE`. Programs
compiled by `yo compile` on Alpine still do, because the driver passes no such flag.

## Position (Fable, unverified)

Do not strip hardening from user programs. Emit the save-old-value copies as `__builtin_memcpy`,
which fortify-headers does not wrap, so they lower to plain moves under any libc. Then measure an
Alpine build of the compiler with fortify on again. If the gap closes, the bundle recipe could drop
`-U_FORTIFY_SOURCE`.

## Reproducer

Inside `alpine:3.20` with build-base and clang:

```sh
echo | clang -O2 -dM -E - | grep FORTIFY       # #define _FORTIFY_SOURCE 2
```

Compile any emitted C with `-O2`, with and without `-U_FORTIFY_SOURCE`, and count `ud2` in
`objdump -d`. For the v0.2.76 compiler C the counts were 6993 and 459. On
`check ./std/collections` the two builds took 82.0 s and 60.7 s.
