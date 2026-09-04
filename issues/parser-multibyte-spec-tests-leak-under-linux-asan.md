# The two multibyte spec-peel parser tests leak under Linux ASan (clang 21) — pre-existing, CI-invisible

**Status: OPEN** (documented 2026-09-03 during the P1 error-diagnostics work —
**not a regression of it**: reproduced on pristine `origin/develop`
`060acdc26` with the stock seed `v0.2.23`, before any of that work's edits).

## Reproducer

```bash
git worktree add /tmp/yo-pristine origin/develop
nix-shell shell.nix --run 'cd /tmp/yo-pristine && ~/.local/bin/yo test ./tests/internal/parser.test.yo --parallel 1 --test-name-pattern "multibyte" -v'
```

## What happens

Two tests fail:

- `Peel a format spec off a MULTIBYTE template expression`
- `A spaced colon-pair stays a colon-pair with multibyte content`

Under the nix `clang` 21.1.2 toolchain (Linux x86_64, Steam Deck), the test
binary's AddressSanitizer/LeakSanitizer run reports at exit:

```
SUMMARY: AddressSanitizer: 1881 byte(s) leaked in 32 allocation(s).
```

The leak stacks are symbol-less (batch-binary offsets), mostly 104-byte
"direct leak" objects — the shape of leaked RC `String`/`ArrayList` temps
(32 allocations ≈ a handful of objects per test iteration).

Under a system `zig` cc (no ASan linked), the same two tests fail with
SIGABRT (rc=134) instead — same two tests, different mechanism.

## Why this is not the error-diagnostics work's regression

1. Reproduced on a pristine worktree of `origin/develop` (`060acdc26`) with
   the unmodified stock seed — none of the P1 edits present.
2. The sibling test `Peeling survives multibyte literal text around the
   interpolation` passes, and every other parser test (52 total) passes,
   including the new `make_parse_error renders via the shared renderer`.
3. develop's CI is green on the same commit (`gh run list --branch develop`
   — "Build and Test" success, 2026-09-03), so CI's clang/runner does not
   surface it.

## Analysis / next steps

- The two failing tests share the MULTIBYTE path of the format-spec peeling
  (`_SpecSplit` / `peel_spec` in `src/parser.yo`) — the leak is plausibly a
  missing drop on a temp in the multibyte scanning loop (byte-indexed walks
  building per-rune strings).
- CI-invisibility suggests an allocator/LSan-version difference, not absence
  of the leak — worth symbolizing locally: rebuild the kept batch
  (`YO_KEEP_BATCH=1`) with `-g` and `ASAN_SYMBOLIZER_PATH` pointed at
  llvm-symbolizer from the nix shell, then map the frames to parser
  functions.
- If confirmed as a missing drop in the peel path, the fix belongs with the
  dup/drop optimizer family (`_optimize_dup_drop_pairs`,
  `src/evaluator/exprs/begin.yo`) or a `consume` at the peel site.
