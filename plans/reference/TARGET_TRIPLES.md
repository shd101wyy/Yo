# The compiler's target vocabulary is the canonical Rust triple

**Status:** LANDED 2026-08-28 (branch `target/rust-triples`). User decision
2026-08-28: *"follow Rust's way; we don't need to worry about backward
compatibility and breaking changes"* — this supersedes the "what does NOT
change" section of `plans/reference/RELEASE_ASSET_TRIPLES.md`, which had kept the
compiler's own `--target` names vendor-less when the release assets moved to
triples.

## Decision

`yo compile --target`, `yo build --target`, `std/build.yo`'s
`CompilationTarget` constants, `TargetInfo.triple`, and the `yo-out/<target>/`
output directory all use the canonical Rust triple — the same string the
release asset is named by, the same string `rustc --target` takes:

| retired spelling | canonical triple | `CompilationTarget` key |
| --- | --- | --- |
| `x86_64-linux-gnu` | `x86_64-unknown-linux-gnu` | `X86_64_Unknown_Linux_Gnu` |
| `x86_64-linux-musl` | `x86_64-unknown-linux-musl` | `X86_64_Unknown_Linux_Musl` |
| `aarch64-linux-gnu` | `aarch64-unknown-linux-gnu` | `Aarch64_Unknown_Linux_Gnu` |
| `aarch64-linux-musl` | `aarch64-unknown-linux-musl` | `Aarch64_Unknown_Linux_Musl` |
| `aarch64-macos` | `aarch64-apple-darwin` | `Aarch64_Apple_Darwin` |
| `x86_64-macos` | `x86_64-apple-darwin` | `X86_64_Apple_Darwin` |
| `x86_64-windows-msvc` | `x86_64-pc-windows-msvc` | `X86_64_Pc_Windows_Msvc` |
| `aarch64-windows-msvc` | `aarch64-pc-windows-msvc` | `Aarch64_Pc_Windows_Msvc` |
| `wasm32-emscripten`, `wasm-emscripten` | `wasm32-unknown-emscripten` | `Wasm32_Unknown_Emscripten` |
| `wasm32-wasi`, `wasm-wasi` | `wasm32-wasip1` | `Wasm32_Wasip1` |

Also accepted (grammar, not constants): `x86_64-pc-windows-gnu` (MinGW),
`x86_64-unknown-freebsd` / `aarch64-unknown-freebsd`, and `i686` / `arm`
forms of the linux and windows triples.

### Grammar (`src/target.yo`, `parse_target`)

```
<arch>-<vendor>-<os>[-<env>]
wasm32-wasip1                    (the one two-component form)
```

- **vendor is a function of the OS** — `apple` for darwin, `pc` for windows,
  `unknown` for linux / freebsd / emscripten — and is checked, not skipped:
  `x86_64-pc-linux-gnu` (clang's own default spelling on some hosts) is
  rejected with `expected "unknown"`.
- **env is required where it disambiguates an ABI** (linux: `gnu` | `musl`;
  windows: `msvc` | `gnu`) **and forbidden where the OS has exactly one**
  (darwin, freebsd, emscripten). `x86_64-unknown-linux` is an error, exactly as
  it is for rustc.
- **wasm32 ↔ the wasm OSes**, both directions.
- **No aliases, no shorthands.** The retired spellings are errors. Because the
  whole corpus of docs, CI and user `build.yo` files used them, the error
  carries a *did-you-mean* computed from the words the user typed
  (`x86_64-linux-gnu` → `did you mean "x86_64-unknown-linux-gnu"?`,
  `aarch64-macos` → `aarch64-apple-darwin`, `wasm-wasi` → the two wasm
  triples), then the full supported list. The hint helper recognises the cfg
  names `macos` and `wasi` only to phrase the hint — never to accept them.

### The two vocabularies — deliberately different, as in Rust

Rust's `cfg(target_os = "macos")` coexists with the triple `aarch64-apple-darwin`;
`cfg(target_arch = "x86")` with `i686-…`. Yo has the same split and it is now
explicit in `src/target.yo`:

| | cfg name (`__yo_process_platform()` / `__yo_process_arch()`, `std/process`) | triple word |
| --- | --- | --- |
| macOS | `macos` | `apple-darwin` |
| 32-bit x86 | `x86` | `i686` |
| WASI | `wasi` | `wasip1` |

`os_to_str` / `arch_to_str` give the cfg names (unchanged — every
`cond(platform == Platform.Macos)` in `std/` still folds the same way);
`os_triple_str` / `arch_triple_str` / `os_vendor_str` give the triple words.
`Abi` gained `P1` (Rust's `target_env = "p1"` for `wasm32-wasip1`) and lost the
internal `Wasm_` placeholder; emscripten has no env, as in Rust.

### What clang is given

`clang_triple` returns the canonical triple — LLVM speaks it — except for the
two places LLVM's spelling differs: MinGW is `<arch>-w64-mingw32`, and WASI is
handed `wasm32-wasi`, which every wasi-sdk clang accepts (`wasm32-wasip1`
needs LLVM ≥ 19). **En route fix:** `compile` used to pass the raw `--target`
string to clang (`src/main.yo`, the cross-compile pass-through); it now passes
`clang_triple(target)`, so the MinGW spelling actually reaches clang.

## Blast radius (all in the landing PR)

`src/target.yo` (rewrite), `src/main.yo` (emcc default target, help text,
error wording, clang pass-through), `src/build_runner.yo` (comment),
`std/build.yo` (`CompilationTarget` keys + values), `std/prelude.yo`
(comments), repo-root `build.yo` (the mimalloc host gate compares against the
Linux constants), `tests/internal/target.test.yo` (rewritten: every supported
triple round-trips, every retired spelling is rejected with its hint),
`tests/cli-cases/help-compile/expected_stdout`, `scripts/cli-diff-test.sh`
(the `<TARGET>` normaliser now matches the `unknown-`/`pc-` vendors),
`.github/workflows/{test,release}.yml` (`yo_target:` matrix values, the WASI
leg's `--target`), `.github/instructions/testing.instructions.md`, the two
wasm skills, `docs/{en-US,zh-CN}/{BUILD_SYSTEM,ASYNC_AWAIT,DESIGN,INSTALL_WASM}.md`.

Historical documents under `plans/`, `issues/`, `outdated/` are NOT rewritten
(per AGENTS.md they are records); translate the old spellings as you read.

## Consequences to carry forward

- **`yo-out/<triple>/`** — a compiler built from this tree writes
  `yo-out/aarch64-apple-darwin/bin/yo`; the v0.2.18 *seed* still writes
  `yo-out/aarch64-macos/bin/yo` because the build runner is the seed's own.
  Nothing in CI depends on the path (stage 1 is built with `compile --emit-c`
  to `/tmp/yo-stage1`), but local notes that `cp yo-out/…` must use the new
  name once the fresh binary does the building.
- **`vendor/markdown_yo`** still spells `CompilationTarget.Wasm32_Emscripten`
  and `--target aarch64-macos` in ITS build.yo, release workflow, README and
  skills. It is consumed here as SOURCE only (`src/doc/render_html.yo` imports
  `vendor/markdown_yo/src/lib.yo`), so nothing in this repo breaks — and its
  own CI builds with a *released* `yo`, so it cannot move until a release
  carrying this change exists. **Follow-up, after the next release:** update
  the upstream to the new vocabulary and bump the submodule pointer
  (companion-commit procedure as for std API changes).
- **Release assets** already carry these exact names (PR #323,
  `plans/reference/RELEASE_ASSET_TRIPLES.md`); `scripts/release_asset_triple.sh`'s
  internal-label → triple table stays because the internal labels are also
  artifact names and job titles. `src/version_cache.yo`'s
  `host_bundle_triple_name` could now be derived from `host_target().triple`
  for macOS and Windows; Linux stays a table (the bundle is musl whatever the
  host's libc), so the table is kept as the single source.
- **Release notes** for the next version must list this as a breaking change:
  every `--target` flag and every `CompilationTarget.*` reference in user
  `build.yo` files must be respelled (the error message tells them how).
