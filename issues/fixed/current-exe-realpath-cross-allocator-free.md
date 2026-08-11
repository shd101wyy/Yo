# `current_exe()` freed a libc-malloc'd buffer through GlobalAllocator — shipped in v0.2.0 and v0.2.1

**Status: FIXED 2026-08-11** (`std/env.yo`, macOS branch). Found while probing
the self-hosted test runner's output for P2.5; the released seed bundles print
allocator errors on stderr on **every compile**.

## Symptom

```
$ gh release download v0.2.1 -p 'yo-v0.2.1-macos-arm64.tar.gz' && tar xzf …
$ ./bin/yo compile hello.yo --release -o hello
mimalloc: error: thread 0x340007000: mi_free: invalid pointer: 0x000105AD3250
mimalloc: error: thread 0x340007000: mi_free: invalid pointer: 0x000105AD3650
$ echo $?
0
```

Two errors per compile, deterministic, rc unaffected, output correct. The two
pointers are always exactly `0x400` apart — 1024 bytes, macOS `PATH_MAX`.

## Root cause

`std/env.yo:12` binds the allocator used throughout the file:

```rust
{ malloc, free } :: GlobalAllocator;
```

The macOS branch of `current_exe()` then took its canonical path from
`realpath` with a NULL output buffer:

```rust
resolved := unsafe(realpath(pbuf, .None));   // buffer from LIBC's malloc
…
free(.Some(*(void)(rp)));                    // released through GlobalAllocator
```

With a NULL second argument `realpath` returns a `PATH_MAX` buffer allocated by
libc inside libSystem. `GlobalAllocator.free` is `__yo_free`, which under
`--allocator mimalloc` — **the configuration every release bundle uses** — is
`mi_free`. mimalloc correctly refuses a pointer it never handed out: it prints
`mi_free: invalid pointer`, returns, and the buffer leaks. One leaked
`PATH_MAX` block and one stderr line per `current_exe()` call.

Two per compile because the std-path resolution added in the 2026-08-10
std-resolution rework (`yo-self/module_manager.yo:181`, the exe-relative
walk-up) calls `current_exe()` twice per process.

Note this cannot be fixed by "call libc's `free` instead": mimalloc overrides
the global `free` symbol in the linked binary, so an extern `free` resolves to
`mi_free` too. The libc buffer must never be created.

## Fix

Pass our own buffer, so the allocation and the release are the same allocator
(`std/env.yo`, macOS branch of `current_exe`):

```rust
rbuf := *(char)(malloc(usize(4096)).unwrap());
resolved := unsafe(realpath(pbuf, .Some(rbuf)));
…
.None => { free(.Some(*(void)(rbuf))); .Err(…) },
.Some(rp) => { exe_str := String.from_cstr(*(u8)(rp)).unwrap();
               free(.Some(*(void)(rbuf))); .Ok(Path.new(exe_str)) }
```

POSIX requires a caller-supplied `resolved_path` to hold at least `PATH_MAX`
bytes; 4096 covers macOS's 1024. The failure path frees the buffer too — with
a NULL output buffer there was nothing to free on failure, so that branch is
new.

The Linux branch (`readlink` into a Yo-allocated buffer) and the Windows branch
(`GetModuleFileNameW` into a Yo-allocated buffer) were already
allocator-consistent. A sweep of the rest of `std/` found no second instance:
`getenv`'s static pointers are never freed, and `mkdtemp`/`mkstemp`/
`IO_path.realpath` all write into caller buffers.

## Verification

A user program calling `current_exe()` three times, compiled
`--release --allocator mimalloc`:

|        | invalid frees                              | output  |
| ------ | ------------------------------------------ | ------- |
| before | **3** (one per call, pointers 0x400 apart) | correct |
| after  | **0**                                      | correct |

## Why CI never caught it — and the gate that now does

`rc` stays 0, stdout is unaffected, and the differential harness compares rc +
stdout + trees, not stderr. Both smoke tests asserted only the program's
output. So a leak-and-warn bug in the compiler's own std usage was invisible to
every arm, and shipped twice.

Both smokes now capture the compiler's stderr and fail on `mimalloc: error`:

- `.github/workflows/test.yml` — the per-leg native probe (all five platforms).
- `.github/workflows/release.yml` — the bundle smoke, so a release cannot be
  published past it.

This gates the whole class (any future cross-allocator free reachable from a
hello-world compile), not just this site. It is the only practical detector:
mimalloc's refusal is the diagnosis, and it only speaks on stderr.

## Lesson

**A binary that ships with mimalloc has a free correctness oracle on its
stderr, and discarding stderr discards it.** The two allocator-related pitfalls
in this codebase now both bite through `GlobalAllocator`: RC drops need an env
`Variable` to be emitted at all, and any pointer obtained from a C library that
allocates must never reach `GlobalAllocator.free` — prefer the caller-buffer
form of such an API even when the NULL form is more convenient.
