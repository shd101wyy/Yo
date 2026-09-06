# `Path.strip_prefix` was node's `path.relative` under Rust's name

**Status: FIXED** (2026-09-06, `std/path.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 8.

## Symptom

```rust
Path.new(`/usr/share/doc`).strip_prefix(Path.new(`/usr/local/lib`))
// was:  ../../share/doc      (a way to GET THERE)
// Rust: Err — /usr/local/lib is not a prefix of /usr/share/doc
```

Rust's `Path::strip_prefix(base)` is "the remainder after `base`, or an
error when `base` is not a prefix". Yo's walked up with `..` segments instead
— node's `path.relative(from, to)` — so a caller checking "is this file under
that directory" by stripping got a path back for EVERY input, and one that
silently escaped the directory.

## Fix

- `strip_prefix(base) -> Option(Path)`: `.None` unless `base` is a
  segment-wise prefix (`starts_with`); the remainder as a relative path
  otherwise (equal paths → the empty relative path, which renders as `.`).
  `Option` mirrors `String.strip_prefix`, the module's existing convention for
  "the prefix was not there".
- The old behaviour is kept as **`relative_to(base)`** — node's `relative`,
  which is what the compiler's four callers (`build_runner`, `doc_command`,
  `fetch_command`, `main`'s fmt output) actually want: a display path relative
  to the project directory, `..` and all. They were moved.

## Regression tests

`tests/path.test.yo` — remainder / equal / not-a-prefix / textual-not-
segment-wise / absolute-vs-relative / relative inputs, and `relative_to`'s
`../../share/doc`.
