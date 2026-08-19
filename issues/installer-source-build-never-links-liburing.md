# `install.sh --from-source` never passes `-luring`, and `install.ps1` never checks for the Windows SDK

**Status: FIXED** (found and fixed 2026-08-19, during a fresh-machine audit of
both installers).

Two independent gaps, found by asking one question of each script: _what does a
machine that has nothing on it actually need, and does the script provide it?_

## 1. The source build cannot link on any Linux box that has liburing headers

`install_from_source` compiled the published single-file `yo.c` with:

```sh
"$CC_BIN" -std=c11 -fno-strict-aliasing -fwrapv -w -O2 \
  "$YO_TEMP_DIR/yo.c" -o "$YO_TEMP_DIR/yo" $CFLAGS_OVERRIDE -lpthread -lm
```

No `-luring`. But the emitted C opens its Linux async runtime with

```c
#if __has_include(<liburing.h>)
#define __YO_HAS_LIBURING 1
#include <liburing.h>
```

(`yo-self/codegen/async/runtime_io_linux.yo:510`), and the runtime it then
compiles in calls real liburing symbols — `io_uring_queue_init`,
`io_uring_submit`, `io_uring_wait_cqe` — not merely the header's `static
inline` helpers. `__has_include` is evaluated on the INSTALLING machine, so the
mere presence of the header flips on code that cannot link without the library:

```
undefined reference to `io_uring_queue_init'
```

This is exactly the trap `check_liburing_consistency` already warns users
about ("Yo emits io_uring calls whenever that header exists, but only passes
-luring when pkg-config succeeds"). The installer's own compile line did not
obey it.

The reach is wider than it looks:

- `install_dependencies` installs `liburing-dev` BY DEFAULT, immediately before
  the source build — so the default flow creates the failing condition itself.
- The script's NixOS advice is `nix-shell -p clang git pkg-config liburing`,
  which supplies the header too. NixOS is the case `--from-source` exists to
  serve, and following the printed instructions walked into the failure.

**Why nothing caught it:** `install-scripts.yml` never runs `--from-source` at
all. Its only mention is a negative assertion that the musl path does _not_
print the `--from-source` advice.

**Fix.** Decide the flag the same way the compiler itself decides it —
`pkg-config --exists liburing` — and pass `pkg-config --libs liburing`. When
liburing is NOT visible, warn loudly, because the silent direction is the
dangerous one: with no header the file compiles happily and the async runtime is
replaced by stubs, producing a `yo` that cannot read source files at all.
`test.yml`'s musl leg asserts against precisely that outcome:

```
::error::async I/O was compiled OUT — the binary would fail to read sources
```

## 2. `install.ps1` never mentions the Windows SDK

`clang` on PATH is not a working C toolchain on Windows. Clang targets MSVC
there: `<stdio.h>` comes from the Windows SDK's UCRT, and the import libraries
Yo links (`-lws2_32 -lbcrypt -ladvapi32`, `yo-self/main.yo:1652`) are SDK
libraries. `winget install LLVM.LLVM` installs clang alone, so a fresh Windows
machine ends up with a clang that cannot build anything.

The repository **already documents this** — `README.md` and
`docs/zh-CN/README.md` both tell users to install Visual Studio or the Build
Tools with the "Desktop development with C++" workload. Nothing in the install
path acted on it: the user got a raw clang error from the hello-world
verification and no indication of what to install.

**Why nothing caught it:** `install-scripts.yml` runs `install.ps1` on
`windows-latest`, which ships Visual Studio. CI has always had an SDK and has
never once run the configuration a new user actually has.

**Fix.** A compile-and-link probe (`Test-CToolchain`) that builds a trivial C
file and, on failure, names the requirement and the exact `winget` command for
the Build Tools workload. It is a real compile rather than a registry or path
check for the same reason `Verify-Install` compiles a hello world: nothing else
is immune to a partial install.

It deliberately does NOT install the Build Tools. They are a multi-gigabyte
download, and a script piped from the internet should not start one unasked.

## Lesson

Both gaps share a shape: **CI runners are richer than user machines.** GitHub's
`windows-latest` has Visual Studio; its Ubuntu images have build tooling
preinstalled. An installer's job is to work on the machine CI never runs on, so
"green in install-scripts.yml" says nothing about a fresh box. The same shape
produced the v0.2.10 release failure, where a job died for want of liburing
that every other job happened to have.
