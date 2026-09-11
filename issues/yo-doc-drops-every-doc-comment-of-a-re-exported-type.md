# `yo doc` drops every doc comment of a re-exported type

**Status:** OPEN. Found 2026-09-11 while re-measuring the campaign's doc-coverage
row after trait-doc inheritance (#579) landed.

## Symptom

A type declared in one file and re-exported from another is rendered with **no
documentation at all** — not its own doc, not any of its methods' — even though
every one of them carries a `///` comment.

Minimal reproducer, two files in one directory:

```rust
// point.yo
/// A point in the plane.
Point :: struct(x : i32, y : i32);
impl(
  Point,
  /// Make a point at the origin.
  origin : (fn() -> Self)(Point(x : i32(0), y : i32(0))),
  /// The x coordinate, doubled.
  double_x : (fn(self : Self) -> i32)((self.x * i32(2)))
);
export(Point);

// index.yo
{ Point } :: import("./point.yo");
export(Point);
```

`yo doc . --format json`:

```
=== module point
  type Point doc='A point in the plane.'
    method origin     doc='Make a point at the origin.'
    method double_x   doc='The x coordinate, doubled.'
=== module index
  type Point doc=None
    method origin     doc=None
    method double_x   doc=None
```

## Why it matters — the measured cost

`std/` is organised as `foo/index.yo` re-exporting `foo/thing.yo`, so this hits
almost everything a reader actually opens. Measured on develop
(`yo doc ./std --format json`, 175 modules, 3345 functions + methods):

| | count |
| --- | --- |
| documented | 1791 |
| **undocumented** | **1554** |
| of those, filled by trait inheritance (#579) | 110 |

The worst modules are exactly the re-exporting ones: `string/index` 275,
`http/index` 93, `imm/string` 62, `process/index` 50, `regex/index` 39. On
`String` and `rune`, the ONLY methods with any doc are `format` on each — and
they have one because #579 inherits it from the `Format` TRAIT, not because
their own comment was found.

This also makes the campaign's docs row meaningless as written:
`plans/STD_API_STABILIZATION.md` reports "479 undocumented members" from a
SOURCE grep for `///`, while what `yo doc` publishes is 1554 — the difference is
almost entirely this bug, not missing comments. A doc sweep aimed at that 479
would write comments that `yo doc` then discards.

## Root cause

`_build_module_doc` (`src/doc_command.yo`) documents one file at a time:

```rust
tokens := tokenize(src, `file://${file_path}`, lex_exn);
extraction := extract_doc_comments(tokens);
outcome := mm_load_file(file_path, …);
… build_doc_module(module_name, module_name, outcome.module_value, …, extraction, tokens, outcome.env)
```

`extraction` holds the doc comments of **that file only**. A re-exported type's
declaration — and therefore its `///` comments — lives in a different file, so
every lookup misses and the member renders bare.

The lookup key is already cross-file safe:

```rust
get_doc_comment_lookup_key :: (fn(comment : DocComment) -> String)(
  `${comment.module_path}:${comment.row.to_string()}:${comment.column.to_string()}`
);
```

It leads with `module_path`, so doc comments from every file in the walk can
share ONE map without colliding — the map is simply never built that way.

## Fix direction

Extract doc comments for every file in the walk FIRST, merge them into one
lookup keyed as above, and hand that merged map to `build_doc_module` (each
module still needs its own token list for its `//!` header and for ordering).
A member then resolves its doc by its own defining position regardless of which
module is being rendered.

Worth checking while in there: `issues/yo-doc-renders-std-prelude-as-an-empty-module.md`
is plausibly the same family — the prelude is the extreme case of a module whose
contents are declared elsewhere.

## Regression test

`tests/internal/doc_*.test.yo` — the two-file shape above, asserting that the
re-exporting module's type and methods carry the same docs as the defining
module's. The current pipeline passes its existing tests because every fixture
declares and documents in ONE file.
