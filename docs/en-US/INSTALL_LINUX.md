<!-- Split out of README.md so the front page can lead with the install
script, which sets these up for you. This guide is for manual setup and
for troubleshooting. -->

# Installing the C toolchain on Linux

> **You probably do not need this page.** `scripts/install.sh` installs a C
> compiler and the rest of these dependencies for you — see
> [Installation](../../README.md#installation). Read on only if you are
> setting the toolchain up by hand, or diagnosing a failed install.


Install **Clang** (recommended) and **pkg-config** (for system library discovery). Async I/O needs no extra library: the runtime speaks io_uring directly through a ring layer vendored into the emitted C, and needs only a Linux kernel of 5.6 or newer:

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang pkg-config

# Fedora/RHEL
$ sudo dnf install clang pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang pkgconf
```

You can also use `gcc` or `zig` instead of `clang` by passing `--cc gcc` or `--cc zig`.
