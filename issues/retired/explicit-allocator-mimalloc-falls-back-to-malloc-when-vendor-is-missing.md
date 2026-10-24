# An explicit `--allocator mimalloc` silently becomes glibc `malloc` when `vendor/mimalloc` is missing

**Kind:** design question. **Status:** RETIRED — decided 2026-10-24 (maintainer): option 2, a hard error.
Implemented for `--allocator mimalloc` (and a `build.yo` artifact that sets it) by
`fix/mimalloc-missing-vendor-hard-error`, without waiting for `plans/backlog/ALLOCATOR_PLACEMENT.md` step C, which
carries the same error over to its link-source declaration. The analysis below is the record the decision was made
on; its line numbers are develop's at `82671f612`.

Found 2026-09-29 while measuring the codegen memory plan
(`plans/CODEGEN_MEMORY_REDUCTION.md`).

## What

`yo compile … --allocator mimalloc` links the bundled mimalloc from
`<std>/../vendor/mimalloc/src/static.c`. When that file does not exist, the
C-compile step prints one line and links the system allocator instead
(`src/main.yo`, the "Bundled mimalloc allocator (else system)" block, lines 7815-7835 at `82671f612`):

```
Bundled mimalloc not found, falling back to standard malloc
```

The exit status is 0 and the binary is otherwise identical. `vendor/mimalloc`
is a git submodule, so any worktree created without
`git submodule update --init` hits this path.

## Why it matters

The flag was given explicitly and was not honoured. Measured 2026-09-29: two
worktrees of the same branch, one without the submodule, produced a "mimalloc"
stage-2 on glibc (`nm yo | grep ' mi_malloc$'` is empty) and one on mimalloc.
An A/B between them read as −27 % instructions and +37 MB of RSS for a change
that did neither. Every allocator-sensitive number in the plan's §0.4 table
was in fact glibc against glibc. The one warning line sits among thousands of
lines of build output.

## Options

The default allocator is `system` (`src/main.yo`, `(allocator : String) =
String.from("system")`), so this path only runs when someone asked for
mimalloc: the `--allocator` flag, or a `build.yo` artifact that sets it.

1. Keep the warning-and-fallback (today).
2. Fail: "bundled mimalloc not found at <path>; run `git -c
   protocol.file.allow=always submodule update --init`, or pass
   `--allocator system`".

## Recommendation

Option 2. mimalloc is never the implicit choice, so every fallback overrides
an explicit request. Failing costs the requester one command. The silent
substitution cost a measurement campaign a day of wrong A/B numbers.

## Verdict (maintainer, 2026-10-24)

The maintainer agreed with the recommendation: no silent fallback to `malloc`, a hard error instead. Option 2, and
now rather than at step C, because the fallback is live today. What changed:

- **`yo compile --allocator mimalloc`** fails before evaluation, with rc 1 and no C compile, when
  `<std>/../vendor/mimalloc/src/static.c` does not exist:

  ```
  yo: error: compile: --allocator mimalloc needs the bundled mimalloc, and <checkout>/vendor/mimalloc/src/static.c does not exist. In a source checkout, run `git -c protocol.file.allow=always submodule update --init`; a source install built from the published yo.c ships no mimalloc. Otherwise use the system allocator: pass `--allocator system`, or set `allocator : build.AllocatorKind.System` in build.yo.
  ```

  `yo build` reaches the same error through its child compile (hence the `build.yo` spelling of the remedy), and
  `yo test --allocator mimalloc` checks once before its first batch. `--skip-c-compiler` links nothing and is not
  checked. An install that `scripts/install.sh` built from `yo.c` has no `vendor/` (GitHub's source tarball
  carries no submodule contents), so mimalloc is unavailable there; `docs/*/BUILD_SYSTEM.md` says so.
- **The emitted C** has no `malloc` fallback: its mimalloc block is `#error` when `<mimalloc.h>` is not on the
  include path, then an unconditional `#include <mimalloc.h>`. Hand-compiled `--emit-c` output cannot downgrade
  either. The one consumer that wanted the C library's heap, the memory-ratchet job's work count, now says so with
  `-I scripts/bootstrap/libc_mimalloc` (a stand-in header that maps the `mi_*` calls onto `malloc`/`free`).
- **mimalloc on wasm** follows the same rule: `--allocator mimalloc` with a wasm target is an error (it was silently
  `system`). Nothing in CI or `scripts/` asked for that combination.
- **The raw `__yo_build_executable` builtin** defaults its allocator to `system`, matching `build.Executable`'s
  default; it defaulted to `mimalloc`, the one implicit mimalloc request left.

Every release bundle ships `vendor/mimalloc` beside `std/` (`release.yml`, both bundle jobs), so an installed `yo`
is not affected. Test: `tests/cli-cases/compile-allocator-mimalloc-missing-vendor`.

