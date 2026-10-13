# `yo check ./tests` fails files that check clean on their own

**Severity:** S3 — directory-mode `check` over `tests/` reports dozens of spurious failures (and the v0.2.60 seed dies partway), so it cannot be used as a sweep or a gate; each file checks clean when checked alone.

> Found 2026-10-13 while sweeping the `&&`/`||` fold fix
> (`issues/fixed/comptime-identity-operand-folds-and-or-to-a-constant.md`).
> **OPEN.**

## Symptom

```sh
yo check ./tests --exclude tests/cli-cases --std-path ./std
```

- A tree build of `fix/comptime-and-or-fold` (macOS arm64): rc 1,
  `check: 116 file(s) failed evaluator coverage`, `630/746 file(s) passed`.
  Many failures are derive errors on types from OTHER files that all cite one
  impl in `tests/copy_trait.test.yo`:

  ```text
  error: derive on "Cell(T)" failed: Type "Cell(T)" implements Copy, so its Clone may not be hand-written (the hand-written Clone impl is at tests/copy_trait.test.yo:96:1): …
  ```

- The v0.2.60 seed on the same tree: rc 138 (SIGBUS) after about 430 files,
  with 54 failures among them.
- The failing sets differ between the two binaries in both directions. Every
  non-negative file the tree binary failed in directory mode
  (`tests/codegen-bootstrap/nested_cond.yo`, `tests/collections/ordered_map.test.yo`,
  `tests/inline_builtin_alias.test.yo`, `tests/impl.test.yo`,
  `tests/type_soundness.test.yo`, … 21 files) passes with rc 0 when checked
  alone (`yo check <file> --std-path ./std`).

## Likely cause

Directory-mode `check` evaluates every file in one process, and some
per-program state (the impl registry the derive rule reads, at least) is not
reset between entry files. A type named `Cell`, `Wrap`, … in one file meets the
hand-written `Clone` impl registered by `copy_trait.test.yo`. `yo test` compiles
each file separately and is not affected; `check ./src` and `check ./std` are
one program each and are not affected either.

## Next step

Find the registry the derive check consults and key it by module (or reset it
per entry file), then add a cli-case that checks a two-file directory in which
both files declare a same-named type, one with a hand-written `Clone`.
