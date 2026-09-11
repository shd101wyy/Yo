# `yo doc` drops every doc comment of a re-exported type

**Status:** FIXED 2026-09-11 — `_fill_re_exported_docs`
(`src/doc/builder.yo`), a model pass beside `_inherit_trait_method_docs`.
Found while re-measuring the campaign's doc-coverage row after trait-doc
inheritance (#579) landed.

**Result:** the two-file reproducer below now renders identically under both
modules, and `std/`'s undocumented count drops **1554 → 1293** of 3345. `String`
alone goes from 115 undocumented methods to 21. What remains is a DIFFERENT
class — trait-impl methods that `_inherit_trait_method_docs` is not reaching
(`next`/`map`/`filter` from `Iterator`, `==`/`cmp`, `to_string`) and ~304
genuinely undocumented `libc/*` externs — so the residue is its own follow-up,
not this bug.

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

## The fix as landed

Not the token-plumbing route sketched below — that would have meant threading a
cross-file map through the ~12 name-keyed `doc_lookup.get` sites in the builder,
where a naive merge collides (`new` is declared in dozens of files).

Instead a MODEL pass, `_fill_re_exported_docs`, runs beside the trait-doc
inheritance pass once every module is built: a type missing documentation takes
it from another module's type with the same **name AND signature**. A genuine
re-export is the same declaration, so its rendered signature matches by
construction, while two distinct types sharing a name differ in theirs — which
is what keeps `std/`'s several same-named types apart. Only `.None` is filled,
so a module that documents a re-export itself keeps what it wrote.

Two details that cost a measurement each:

* **Write back by INDEX.** `DocType`/`DocFunction` are value structs, so
  mutating a `.get()` result changes a copy and is silently lost. The pass
  rebuilds each entry (`types(ti) = DocType(…)`), the same way
  `_inherit_trait_method_docs` does.
* **Keep the RICHEST donor, not the first.** A re-exporting module's own entry
  can carry a doc or two — `String` in `string/index` has `format`, inherited
  from the `Format` trait — and registering that first let it claim the key and
  block the declaring module's fully documented entry. With first-wins the
  count only fell to 1414; scoring donors by documented-member count took it to
  1293.

The original sketch is kept below for the record.

### Original fix direction (not taken)

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
