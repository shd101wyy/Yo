<!-- Split out of README.md so the front page can lead with the install
script, which sets these up for you. This guide is for manual setup and
for troubleshooting. -->

# Installing the C toolchain on macOS

> **You probably do not need this page.** `scripts/install.sh` installs a C
> compiler and the rest of these dependencies for you — see
> [Installation](../../README.md#installation). Read on only if you are
> setting the toolchain up by hand, or diagnosing a failed install.


Clang is included with Xcode Command Line Tools:

```bash
$ xcode-select --install

# Also install pkgconf for system library discovery
$ brew install pkgconf
```

Or install LLVM via Homebrew:

```bash
$ brew install llvm pkgconf
```
