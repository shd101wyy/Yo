<!-- Split out of README.md so the front page can lead with the install
script, which sets these up for you. This guide is for manual setup and
for troubleshooting. -->

# Installing the C toolchain on Linux

> **You probably do not need this page.** `scripts/install.sh` installs a C
> compiler and the rest of these dependencies for you — see
> [Installation](../../README.md#installation). Read on only if you are
> setting the toolchain up by hand, or diagnosing a failed install.


Install **Clang** (recommended), **liburing** (for async I/O), and **pkg-config** (for system library discovery):

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang liburing-dev pkg-config

# Fedora/RHEL
$ sudo dnf install clang liburing-devel pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang liburing pkgconf
```

You can also use `gcc` or `zig` instead of `clang` by passing `--cc gcc` or `--cc zig`.
