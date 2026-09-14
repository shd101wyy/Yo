# The liburing `#else` fallback does not compile: async sleep is emitted outside the guard

**Status: FIXED 2026-08-15** (found while sizing
`plans/reference/PORTABLE_C_DISTRIBUTION.md`; surfaced by an adversarial review and then
verified end-to-end.)

## The claim this refutes

`plans/archive/P3_DISTRIBUTION.md` documents the Linux async runtime as degrading
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

## Fix (applied)

The Linux `__yo_async_sleep_start` is now emitted inside `#ifdef
__YO_HAS_LIBURING`, with an `#else` stub of the same signature returning an
immediately-failed future (`-ENOSYS`), matching the other stubs in
`runtime-io-linux.ts`'s `#else` arm. So a program that only SLEEPS still links
and reports a runtime error rather than failing to build.

`__YO_HAS_LIBURING` is safe to test here because `generateAsyncRuntimeIOLinux`
runs BEFORE `generateAsyncRuntimeIOCommon` (`src/codegen/async/runtime.ts:55-67`),
so the macro is already defined-or-not by the time this block is emitted.

Applied to BOTH compilers: `src/codegen/async/runtime-io-common.ts` and
`yo-self/codegen/async/runtime_io_common.yo`.

### Verified

A checker walks the emitted C's conditional nesting and reports any io_uring
symbol reachable when liburing is absent. Validated red-first on the SAME
program before and after:

```
pre-fix  emit: 4 ring refs outside a liburing branch
                 3805: struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
                 3815: io_uring_prep_read(...)  3816: io_uring_sqe_set_data(...)
                 3817: __yo_io_ring_submit(future);
post-fix emit: 0
```

Plus `check yo-self/codegen/async/runtime_io_common.yo` clean and
`tests/async_await.test.yo` 164/164 on macOS (unchanged path, guarding against
collateral damage).

### Still missing: the gate

Nothing in CI compiles an emitted Linux C **without** liburing-dev, which is
why this survived. The `#else` arm remains untested code. The cheap version is
the checker above run over an emitted Linux C; the honest version is a job that
actually compiles one on a box without the headers.
