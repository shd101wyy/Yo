<!-- Split out of README.md so the front page can lead with the install
script, which sets these up for you. This guide is for manual setup and
for troubleshooting. -->

# Installing the C toolchain on HarmonyOS

> **You probably do not need this page.** `scripts/install.sh` detects
> HarmonyOS and installs every dependency for you — see
> [Installation](../../README.md#installation). Read on only if you are
> setting the toolchain up by hand, or diagnosing a failed install.

HarmonyOS has no prebuilt Yo bundles, so the installer builds Yo from the
published single-file `yo.c` (the per-target `yo-v<tag>-linux-<arch>.c.gz`
artifact — HarmonyOS is a musl system on a Linux-derived kernel, so the Linux
target builds with the OHOS toolchain). Before that can happen the machine
needs a package manager and a few packages:

## 1. harmonybrew

HarmonyOS has no apt/dnf/pacman. Package management is **harmonybrew**, a
Homebrew reimplementation whose `brew` command works like macOS's. Install it
first (the installer refuses to guess):

- <https://harmonybrew.atomgit.com/>

## 2. Install the toolchain

```bash
$ brew install git curl pkgconf liburing ohos-sdk
```

| package    | provides                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| `ohos-sdk` | `clang` / LLVM (targets `aarch64-unknown-linux-ohos`)                    |
| `liburing` | io_uring headers + library (async I/O)                                   |
| `pkgconf`  | `pkg-config` — how the compiler finds `liburing`                         |
| `git`      | dependency management (`yo fetch` / `yo install`)                        |
| `curl`     | the installer and the compiler's release downloads                       |

`pkgconf` must pair with `liburing` exactly as on Linux: Yo adds `-luring`
only when `pkg-config --exists liburing` succeeds, so a box with the header
but no pkg-config emits io_uring calls it cannot link.

## 3. Install Yo

```bash
$ curl -sSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh
```

The installer:

1. detects HarmonyOS (`uname -s` reports `HarmonyOS`),
2. checks `brew` is present, installing `git curl pkgconf liburing ohos-sdk`
   through it when missing,
3. downloads `yo-v<tag>-linux-<arch>.c.gz` and the release source tarball,
4. compiles `yo.c` with the OHOS clang (with liburing compiled in), and
5. installs `yo` under `<prefix>/lib/yo/<tag>` and links `<prefix>/bin/yo`.

## Requirements & troubleshooting

- **The kernel must support io_uring.** The compiler reads every source file
  through `io.await(read_file(...))`, and the Linux async runtime
  unconditionally uses io_uring when liburing is present — there is no
  blocking-I/O fallback, and a build *without* liburing compiles to stubs that
  cannot read files at all. On kernels where `io_uring_setup` is unavailable
  the compiler exits with `[Yo] io_uring_queue_init failed: ...` at startup.
- **Releases before the C11-compatibility fixes cannot build here.** The OHOS
  clang is strict C11: it rejects labels standing directly before a
  declaration, and the OHOS sysroot does not expose `struct statx` through
  `<sys/stat.h>`. Both were fixed in the emitted C (null statements after
  async-while labels; `#include <linux/stat.h>` under `__OHOS__`), so `yo.c`
  from a release published after those fixes compiles cleanly. Older releases
  fail with `expected expression` / `incomplete definition of type
  'struct statx'` — use a newer release.
- **User programs compile with the same clang.** `yo compile` invokes `clang`
  by default, so the same strict-C11 guarantees apply to everything Yo emits
  — which is why the fixes above live in the codegen, not the installer.
- **The OHOS loader is strict about runtime library paths.** Measured on a
  HarmonyOS PC (HongMeng kernel, ohos-sdk 26.0.0.18): the loader resolves
  libraries from the musl search paths (`/etc/ld-musl-aarch64.path`), and the
  SDK's bundled `llvm/lib/libxml2.so.16` cannot be symbol-resolved, so
  clang's linker `ld.lld` fails with `Error relocating ... xmlFreeDoc:
  symbol not found`. Workaround that works: preload the harmonybrew libxml2 —
  `export LD_PRELOAD=$(brew --prefix)/lib/libxml2.so.16` — and note that
  setting `LD_LIBRARY_PATH` to a brew directory makes the loader ignore
  `LD_PRELOAD` (secure-mode behavior), so preload-only for compiles, and put
  brew's `lib` on the loader path file (or accept `LD_LIBRARY_PATH` only when
  *running* binaries, not when compiling). A fixed `ohos-sdk` bottle will
  make this moot.
