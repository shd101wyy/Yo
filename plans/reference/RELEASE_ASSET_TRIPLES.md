# Release assets move to canonical target triples

**Status: LANDED 2026-08-28** — commit `b46d29f71` ("release: name assets by
canonical target triple (#323)"). The IN PROGRESS header below predates the
merge; applies from the release AFTER v0.2.18.

## Decision

Published release assets are named by the canonical Rust-style target triple,
not by the short internal label:

| internal label (unchanged) | published asset name |
| --- | --- |
| `macos-arm64` | `aarch64-apple-darwin` |
| `macos-x64` | `x86_64-apple-darwin` |
| `windows-arm64` | `aarch64-pc-windows-msvc` |
| `windows-x64` | `x86_64-pc-windows-msvc` |
| `linux-arm64-musl` | `aarch64-unknown-linux-musl` |
| `linux-x64-musl` | `x86_64-unknown-linux-musl` |
| `linux-arm64` (portable C only) | `aarch64-unknown-linux-gnu` |
| `linux-x64` (portable C only) | `x86_64-unknown-linux-gnu` |

So `yo-v0.2.19-aarch64-apple-darwin.tar.gz`, and the portable single-file C
assets follow the same stems (`yo-v0.2.19-x86_64-unknown-linux-gnu.c.gz`).

### Why the ABI field is the point

The suffix already existed where it mattered: Linux ships `-musl` because glibc
and musl are different ABIs for the same OS. Windows has exactly that situation
— MSVC vs GNU/mingw — and shipped an unqualified `windows-x64`, even though the
bundles really are MSVC (`release.yml` passes `clang_target:
x86_64-pc-windows-msvc` and takes mimalloc's MSVC-C path). Triples make the ABI
explicit everywhere and end the question.

`-darwin` on its own was rejected as redundant (macOS *is* Darwin); the triple
form says `apple-darwin` INSTEAD of `macos`, which is why it reads correctly.

## What does NOT change: the compiler's own target vocabulary

`yo compile --target`, `yo build`, and `std/build.yo`'s exported
`CompilationTarget` keep their vendor-less names (`aarch64-macos`,
`x86_64-windows-msvc`, `x86_64-linux-gnu`, `wasm32-wasi`). They cannot take Rust
triples as-is: `src/target.yo`'s `parse_target` accepts two or three dash
components and has no vendor field, so `aarch64-apple-darwin` parses as
os=`apple`, abi=`darwin` and fails "Unknown OS in target triple", while
`x86_64-pc-windows-msvc` has four components and fails the arity check outright.

Aligning them would mean changing that parser, the ten exported
`CompilationTarget` constants (public API), every `--target` string in docs,
tests and cli-cases, and every user's `build.yo`. That is a much larger breaking
change than renaming assets, and it is deliberately NOT part of this one.

**If we want one vocabulary later, do it additively**: teach `parse_target` to
also accept the four-component vendor form and the `apple-darwin` pair, and add
new `CompilationTarget` constants beside the existing ones. Nothing breaks, and
it can land any time. The inconsistency it removes is real but cosmetic: a user
downloads `…-x86_64-pc-windows-msvc.tar.gz` and then writes `--target
x86_64-windows-msvc`.

## Where the name is produced and consumed

Four places, and the duplication is inherent: `install.sh` and `install.ps1` are
fetched standalone over HTTP, so they cannot share a mapping file with the repo.

1. **`.github/workflows/release.yml`** — produces. Three naming sites: the
   cross-emitted seed bundle, the static musl bundle, and the portable `.c.gz`
   split. The internal matrix `target` values stay as they are (they are also
   artifact names, job titles and the portable-arm presence checks); the triple
   is applied at the naming boundary via `scripts/release_asset_triple.sh`.
2. **`scripts/install.sh`** — consumes: `uname` → arch/OS → triple.
3. **`scripts/install.ps1`** — consumes: `$env:PROCESSOR_ARCHITECTURE` → triple.
4. **`src/version_cache.yo`** — consumes: `host_bundle_name`, compiled INTO every
   installed `yo`, which is what makes the migration below necessary.

## Migration

**No backward-compatibility machinery** (maintainer decision 2026-08-28: "we
don't need to worry about backward compatibility — only need to make the latest
work"). The renamed assets are simply what the next release publishes; there is
no duplicate upload under the old name, and nothing is added purely to keep
older releases reachable.

What IS kept is the probe that makes **today's** latest work, because v0.2.18 —
the current release, and the current `SEED_VERSION` — carries the short names:

- `scripts/install.sh` / `scripts/install.ps1` try the triple asset and fall
  back to the short name, so `curl | sh` installs v0.2.18 now and v0.2.19 later
  without a flag day.
- `src/version_cache.yo` does the same in `download_version`, which is what
  `yo version install` uses.
- `.github/actions/install-seed` probes both, since `SEED_VERSION` crosses the
  naming change exactly once.

Each of those three arms is marked removable once no supported release or
`SEED_VERSION` predates the change. The pre-existing Linux glibc-era fallback in
`download_version` is untouched — it is older than this change and belongs to a
separate decision.

Note for whoever removes them: all three consumers derive the extracted
directory from the asset name, EXCEPT `version_cache.yo`, which now finds the
bundle root by looking for the directory containing `bin/` and `std/`. That
decoupling is why a rename no longer needs matching tarball interiors.

## Not renamed

`yolang-<version>.vsix` (the VS Code extension) is not a platform artifact and
keeps its name.
