# DESIGN.md examples write locals declared without `mut(...)`, so they fail with E0917

**Severity:** S3 — a documentation defect: a reader who copies the example gets E0917 instead of the behavior the comments describe.

**Status:** OPEN — found 2026-10-23 while compiling the `RefCell` counter examples
for the `replace_with` rewrite (step 0 of
`issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`).

## What fails

Decision 47 (`plans/VALUES_BY_DEFAULT.md`) made a local immutable unless it is
declared `mut(x) := ...`. Two `docs/*/DESIGN.md` examples predate it:

- **"`&mut` Parameters"** (`docs/en-US/DESIGN.md`, the `swap`/`increment` block;
  the same block in `docs/zh-CN/DESIGN.md`). `x`, `y` and `counter` are lent
  `&mut` but declared with `:=`. Seed v0.2.68:

  ```
  error[E0917]: Cannot lend `&mut` (a `&mut` argument) `x`: it is a binding declared without `mut`, so it is immutable (plans/VALUES_BY_DEFAULT.md decision 47).
  ```

- **`test_capture`** (closure capture section). `counter = (counter + increment)`
  assigns a captured `counter := i32(0)` and fails with E0917 too. Fixed in
  the `replace_with` PR, which touched that example: it is now
  `mut(counter) := i32(0)`, and with that change the example prints the
  `0`/`47` its comments promise.

## Fix

Declare `x`, `y` and `counter` with `mut(...)` in both languages. The real fix
is a check that compiles every runnable ```` ```yo ```` block in `docs/`.
`yo fmt` only parses them, which is how these examples went stale.
