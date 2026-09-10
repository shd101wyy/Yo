# `yo doc` attaches a method's doc comment by BARE NAME, so two types with a same-named method get each other's prose

**Status:** OPEN
**Severity:** wrong output — the generated docs state something false about a
method rather than merely omitting it. Every std module that defines `new` (or
`len`, `get`, `push`, …) on two types in one file is affected, which is most of
`std/collections`, `std/sync` and `std/crypto`.
**Found:** 2026-09-11, during the `std/` `///` doc sweep, while checking that
newly written method docs actually reach `yo doc` output.

`src/doc/builder.yo` looks a member's doc comment up by the member's own name,
not by (type, name). When one file documents `Vs.new` and `Rs.new`, both
methods are given the SAME doc — whichever the extractor saw last — and no
warning is emitted.

## Reproducer

`issues/repros/stddoc-core-doc-comment-attached-by-bare-member-name.yo`:

```rust
/// A plain value struct.
Vs :: struct(x : i32);
impl(
  Vs,
  /// Make one.
  new : (fn(x : i32) -> Self)(Self(x)),
  /// Read it.
  get : (fn(self : Self) -> i32)(self.x)
);
/// A ref struct.
Rs :: ref(struct(y : i32));
impl(
  Rs,
  /// Make a ref one.
  new : (fn(y : i32) -> Self)(Self(y))
);
```

```
$ yo doc issues/repros/stddoc-core-doc-comment-attached-by-bare-member-name.yo \
    --format json -o /tmp/pdoc
  1 module, 3 items documented
```

`/tmp/pdoc/doc.json`, `Vs`'s methods (verbatim, trimmed):

```json
{ "name": "new", "doc": "Make a ref one.",  "selfType": "Vs" },
{ "name": "get", "doc": "Read it.",         "selfType": "Vs" }
```

`Vs.new` is documented as **"Make a ref one."** — `Rs.new`'s comment. `get`,
which is unique in the file, is correct. Expected `Vs.new`: `"Make one."`.

## Root cause

The doc comment table is keyed by member name alone. `Vs` and `Rs` both have a
`new`, the later `impl` block overwrites the earlier entry, and both types then
read the surviving one. `get` is right only because nothing else is called
`get`. The fix is to key doc comments by the definition site (the token
position the extractor already records — `DocPosition`, `src/doc/extractor.yo`)
or by `(selfType, name)`, and to prefer the comment that physically precedes
the member.

## Why it matters now

The 2026-09 `std/` doc sweep is adding several hundred `///` comments, many of
them on `new` / `len` / `get` / `clear` methods of two or three types in the
same file. Every one of those pairs will render one type's prose on another
type's method. The comments in the source are correct; only the generated site
is wrong.

Related: `issues/collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md`
(the `//`-instead-of-`///` half of the same "docs do not reach the site" story)
and `issues/stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md`
(the other failure found in the same session).
