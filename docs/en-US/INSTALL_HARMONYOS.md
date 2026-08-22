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
  Measured on a sandboxed HarmonyOS image: `io_uring_setup` succeeds but
  **`io_uring_enter` (submit) is seccomp-blocked**, killing the process with
  SIGSYS (rc=159) on the first file read — the same Docker-seccomp pattern the
  repo hit in CI (`--security-opt seccomp=unconfined` fixed it there). Real
  host kernels normally allow io_uring; if a HarmonyOS PC policy blocks it,
  Yo currently cannot run there (a blocking-I/O fallback would be a separate
  project).
- **Older releases are patched automatically.** The OHOS clang is strict
  C11: it rejects labels standing directly before a declaration, and the
  OHOS sysroot does not expose `struct statx` through `<sys/stat.h>`.
  Releases cut before the codegen fixes (the v0.2.14/v0.2.15 era) emit C
  with both flaws, so the installer patches the downloaded `yo.c` in place
  before compiling (idempotent transforms — a post-fix release passes
  through unchanged).
- **User programs compile with the same clang.** `yo compile` invokes `clang`
  by default, so the same strict-C11 guarantees apply to everything Yo emits
  — which is why the fixes above live in the codegen, not the installer.
- **The OHOS loader is strict about runtime library paths.** Measured on a
  HarmonyOS PC (HongMeng kernel, ohos-sdk 26.0.0.18): the loader resolves
  libraries from the musl search paths (`/etc/ld-musl-aarch64.path`), so
  brew's `lib` dir is invisible unless it is added there. Worse, setting
  `LD_LIBRARY_PATH` to the brew prefix makes the loader refuse to resolve
  lld's own bundled `libxml2` dependency — clang's linker then dies with
  `Error relocating ... xmlFreeDoc: symbol not found`, and no `LD_PRELOAD`
  workaround survives that environment either. Yo sidesteps all of it by
  **statically linking liburing**: the compiler binary and every program it
  builds only depend on the system libc (verified: the only `DT_NEEDED` is
  `libc.so`). So: keep `LD_LIBRARY_PATH` out of your shell profile. If a
  brew-linked tool needs it, scope it to that command instead.
