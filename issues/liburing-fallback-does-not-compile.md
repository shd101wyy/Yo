# The liburing `#else` fallback does not compile: async sleep is emitted outside the guard

**Status: OPEN** (found 2026-08-15 while sizing
`plans/PORTABLE_C_DISTRIBUTION.md`; surfaced by an adversarial review and then
verified end-to-end.)

## The claim this refutes

`plans/P3_DISTRIBUTION.md` documents the Linux async runtime as degrading
gracefully when liburing is absent:

> the `#else` arm replaces the whole subsystem with stubs whose init does
> nothing but `fprintf(stderr, "[Yo] Warning: liburing not available, async
I/O disabled\n")`

**That is not what happens for any program that uses `sleep`.** The C fails to
compile.

## Verified

```bash
cat > src/tests/fixme.yo <<'EOF'
{ sleep } :: import("std/sys/timer");
{ Exception, IoExn } :: import("std/error");
main :: (fn(io : Io) -> unit)({
  io.await(sleep(u64(1)), IoExn(io : io, exn : Exception(throw : ((_e) -> unwind(())))));
});
export(main);
EOF
./yo-cli compile src/tests/fixme.yo --release --target x86_64-linux-gnu \
  --skip-c-compiler -o /tmp/sleeplinux
```

In `/tmp/sleeplinux.c`:

| line | what                                                                 |
| ---- | -------------------------------------------------------------------- |
| 2582 | `#if __has_include(<liburing.h>)` — guard OPENS                      |
| 2592 | `static _Thread_local struct io_uring __yo_io_ring;`                 |
| 2675 | `static inline void __yo_io_ring_submit(...)`                        |
| 3738 | `#endif // __YO_HAS_LIBURING` — guard CLOSES                         |
| 3767 | `static __yo_io_future_t* __yo_async_sleep_start(...)` — **outside** |
| 3805 | ` struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);`       |

So on a Linux box without `liburing.h`, `__yo_async_sleep_start` references
`__yo_io_ring`, `io_uring_get_sqe`, `io_uring_prep_read`,
`io_uring_sqe_set_data` and `__yo_io_ring_submit`, none of which are defined —
a hard compile error, not a warning.

## Root cause

The guarded Linux runtime is emitted by `src/codegen/async/runtime-io-linux.ts`
(guard at `:537`, `#else` at `:1486`, `#endif` at `:1693` of 1696 lines — i.e.
the whole file is guarded). But the Linux `__yo_async_sleep_start` is emitted
from a **different** file, `src/codegen/async/runtime-io-common.ts:614`, whose
output lands after that `#endif`. The `#else` stub arm in `runtime-io-linux.ts`
therefore has no matching stub for it.

`runtime-io-common.ts` has three variants of this function (`:614` Linux,
`:687`, `:738`), so only the Linux one is affected.

## Why it was never noticed

Every CI job that compiles Linux C installs `liburing-dev`, so the `#else` arm
is never exercised. The `#else` arm is, in effect, untested code.

## Impact

- Any Linux user compiling a Yo program that uses `sleep` without liburing
  headers gets undefined-symbol errors.
- It **breaks the headline promise of the portable-C distribution plan** —
  "download `yo.c` and compile it with any C compiler" is false on Linux
  without liburing-dev, and `yo-self` itself uses timers.
- It undermines the `P3_DISTRIBUTION.md` static-musl reasoning, which assumes
  the fallback is a silent-degradation hazard. It is louder than assumed here
  (a build failure), but only for sleep — file I/O still degrades silently, so
  BOTH failure modes exist.

## Fix

Emit the Linux `__yo_async_sleep_start` inside the guard, and give the `#else`
arm a stub with the same signature (returning an immediately-failed future, in
keeping with the other stubs). Mirror in `yo-self/codegen/async/`.

Add a CI job that compiles an emitted Linux C **without** liburing-dev present,
so the `#else` arm is exercised at all — that is the missing gate that let this
survive.
