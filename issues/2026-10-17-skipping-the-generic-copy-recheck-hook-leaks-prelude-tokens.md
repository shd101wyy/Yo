# Skipping the generic `Copy` recheck's hook leaks prelude `Token`s

**Severity:** S3 — a compiler built so that `_check_generic_copy_clone_exclusion` skips its `Copy` question for unrelated receivers leaks 336 lexer `Token`s (22549 bytes) per evaluation session; the generated programs are unaffected, but every `tests/internal` test that evaluates the prelude fails its LeakSanitizer check.

> Found 2026-10-17 gating
> `issues/fixed/2026-10-15-yo-fix-over-several-files-applies-one-files-generic-impls-to-anothers-same-named-type.md`.
> The leak is latent on develop: develop's evaluation order does not reach it.

## Reproducer

The pre-reorder state of that fix is pinned as the branch
`wip/yofix-token-leak-repro` (commit `54fc9cee4`). There, the generic `Copy`
recheck tests only hand-written `Clone` impls of the SAME declaration
(`_receiver_patterns_could_overlap`) before asking
`_pattern_implements_via_hook`, so the hook no longer runs for every generic
struct's `Clone` as it does on develop:

```console
$ yo build --std-path ./std            # on wip/yofix-token-leak-repro
$ B=yo-out/x86_64-unknown-linux-gnu/bin/yo
$ $B test ./tests/internal/module_invalidation.test.yo --parallel 1 --std-path ./std
  ✗ B1: imported-file edit visible after overlay + invalidation
    SUMMARY: AddressSanitizer: 22549 byte(s) leaked in 336 allocation(s).
  ... 11 of 12 fail the same way
$ $B test ./tests/internal/check_watch.test.yo --parallel 1 --std-path ./std
  ... 12 of 12 fail; the same 22549 bytes in each, more in the tests that re-check
```

Develop at `ed733408c` passes both files (12/12) with no leak report.

## What the leak is

Symbolized with `YO_KEEP_BATCH=1` and `ASAN_SYMBOLIZER_PATH`: three direct
leaks of 64-byte objects (151, 130 and 43 of them) and a few small indirect
ones. Every direct one is allocated by the `Token` constructor
(`__yo_new_<Token>(kind, value, row, column, character, byte_offset,
module_path, input)`) inside the lexer, under parse, under the file load of
the evaluator session. A `Token` that is a DIRECT leak, with its AST holders
gone, has one reference count more than it has holders: a dup with no drop.

The generated C of the branch's new helpers (`_decl_modules_of`,
`_receiver_patterns_could_overlap`) handles no `Token` and is balanced.

## Root cause (suspected)

`_pattern_implements_via_hook` can force pending impls and evaluate their
bodies. On develop it runs at every generic `Copy` impl for every
hand-written generic `Clone` impl (the root-shape prefilter passes every
generic struct, whose printed name is empty), so those impls are forced early.
When the hook is skipped, the same impls are forced later, from another
context. The `Token`-direct-leak signature fits a `Token` dup'ed in a frame
that a caught throw unwinds (an overload trial, a speculative evaluation),
whose drop never runs. Not confirmed: the leaking dup site is not found yet.

## Fix direction

Run the pinned branch's module_invalidation test with the leak's `Token`
allocation tagged (or with a counting hook on `Token` dups) to find the dup
without a drop, then fix that path. Until then,
`_check_generic_copy_clone_exclusion` keeps develop's call order: the hook
runs for every root-shape match, and only the rejection requires the same
declaration.
