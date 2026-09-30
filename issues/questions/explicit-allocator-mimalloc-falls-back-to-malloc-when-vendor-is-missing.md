# An explicit `--allocator mimalloc` silently becomes glibc `malloc` when `vendor/mimalloc` is missing

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN. Found 2026-09-29 while measuring the codegen memory plan
(`plans/CODEGEN_MEMORY_REDUCTION.md`).

## What

`yo compile … --allocator mimalloc` links the bundled mimalloc from
`<std>/../vendor/mimalloc/src/static.c`. When that file does not exist, the
C-compile step prints one line and links the system allocator instead
(`src/main.yo`, the "Bundled mimalloc allocator (else system)" block):

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
