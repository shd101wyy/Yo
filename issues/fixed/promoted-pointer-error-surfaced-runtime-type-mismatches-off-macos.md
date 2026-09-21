# Promoting `-Wincompatible-pointer-types` to an error surfaced two runtime type mismatches that only exist off macOS

**Status:** FIXED 2026-09-21 (same day). Develop's battery on #822 (run
35595090541) went red on seven legs — `test (ubuntu-latest)`,
`test (ubuntu-24.04-arm)`, `test-wasm32_emscripten`, the tier-1 gates, TSan,
the chunked gate and `test (windows-latest)` — while every macOS gate that
#822 was merged on had been green.

## The two mismatches

1. **Atomic compare-exchange helpers, 64-bit (every Linux program).** The
   shared header's `__yo_atomic_compare_exchange_ullong` took
   `_Atomic unsigned long long* obj, uint64_t* expected` and passed both to
   `atomic_compare_exchange_strong_explicit`. On Linux/glibc `uint64_t` is
   `unsigned long`, a distinct type from `unsigned long long` at the same
   width, so the generic's `expected` was an incompatible pointer — error
   at line 342 of EVERY program's shared header, which is why hello-world
   failed in the language-suite legs. The signed twin
   `__yo_atomic_compare_exchange_llong` took `long long* expected` while its
   Yo declaration (`std/libc/stdatomic.yo`) passes `*i64` = `int64_t*`
   (`long` on Linux): the same mismatch at the CALL site
   (`tests/sync/atomic.test.yo`, the TSan leg). macOS and Windows spell
   `int64_t` as `long long`, so neither ever warned there.

2. **Runtime helpers returning `const char*` where the Yo side declares
   `*u8`.** `__yo_dirent_name`, `__yo_inet_ntop`, `__yo_sockaddr_un_get_path`
   (`std/sys/externs.yo`: `-> *u8`). The Yo wrapper
   `dirent_name :: (fn(entry : *u8) -> *u8)(__yo_dirent_name(entry))` lowers
   to a C function returning `uint8_t*` from a `const char*` —
   `-Wincompatible-pointer-types-discards-qualifiers`, in the promoted
   group; clang 20 on windows-latest reported it (`tests/fs/dir.test.yo`).
   The Linux legs never reached it (hello-world failed first).

## Fix

- Both 64-bit compare-exchange helpers take the Yo-side types
  (`int64_t*` / `uint64_t*`, `int64_t` / `uint64_t` desired) and convert
  THROUGH A LOCAL of the atomic's own type (`long long observed = *expected;
  … *expected = observed;`), which is also the correct write-back of the
  observed value on failure. The other widths (`int`, `size_t`, `ptrdiff_t`,
  the 8/16/32-bit stdint pairs) already agree on every supported target.
- The three helpers return `uint8_t*` in every runtime (common, linux,
  macos, windows, wasm) with the cast at the `return`, matching the
  declaration in `std/sys/externs.yo`.

## Gate

CI: the seven legs. Locally only macOS can compile the C, so the local gate
is `yo build` + the language suite (which now exercises the rewritten
helpers on macOS) and a cross-emit of a hello world for
`x86_64-unknown-linux-gnu` with the TREE-BUILT compiler, grepping the shared
header for the new bodies — the seed emits ITS runtime, so a seed cross-emit
proves nothing about a template change.

## Lesson

`yo-local-gate-cannot-see-linux-and-slow-test-failures` gets a concrete
class: a stdint pointer meeting a `long`/`long long` spelling is
platform-dependent C. The runtime templates must not spell 64-bit integers as
`long long` where a stdint pointer can reach them; and a promoted warning
must be assumed to fire on the strictest leg first.
