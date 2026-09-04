# 22 collection methods write their documentation with `//`, so `yo doc` silently drops all of it

**Status:** OPEN
**Severity:** papercut — no runtime effect; the entire method surface of
`PriorityQueue`, and the core of `Deque` and `BTreeMap`, ships with empty
generated documentation.
**Found:** 2026-09-04, during the std-API audit re-measurement of the
`collections/*` row, while checking whether `PriorityQueue`'s min-heap ordering
is documented (it is — at module and type level; the methods are not).

`yo doc` recognises `///`, `//!`, `/** */` and `/*! */` as documentation. A plain
`//` comment is classed as an ordinary comment and skipped. Three collection
modules were written with `//` above their methods, so the prose their authors
wrote never reaches the generated docs, and nothing warns about it.

## Reproducer

```
$ yo doc std/collections/priority_queue.yo --format json -o /tmp/pqdoc
Rendering JSON to /tmp/pqdoc...

Documentation generated successfully!
  1 module, 3 items documented in 0.4s
```

`/tmp/pqdoc/doc.json`, every method of `PriorityQueue` (verbatim, one shown; the
other five are identical in shape):

```json
{
  "name": "peek",
  "signature": "(fn(self : Self) -> Option(T))",
  "parameters": [],
  "returnType": "Option(T)",
  "isMethod": true,
  "selfType": "PriorityQueue"
}
```

There is no `doc` key. Expected: `"doc": "Inspect the smallest element without
removing it."`, which is what `std/collections/priority_queue.yo:40` actually
says — as `//`, not `///`.

Counting methods with no `doc` field in the emitted JSON:

```
priority_queue: methods=10 without-doc=10
deque:          methods=19 without-doc=18
btree_map:      methods=18 without-doc=16
```

Of those, 22 have author-written prose immediately above them in the source that
was thrown away. (The rest — iterator `next` implementations, mostly — genuinely
carry no comment; that is a separate, smaller gap.) The module docs and type docs
in all three files use `//!` and `///` correctly and do survive, which is why the
loss is easy to miss: `PriorityQueue`'s "Min-heap backed by an ArrayList" renders
fine while all six of its methods render blank.

## Root cause

One authoring mistake in three files, not a `yo doc` defect.

`src/doc/extractor.yo:66-74`, `is_doc_comment_token_`, admits exactly four token
kinds:

```rust
is_doc_comment_token_ :: (fn(token : Token) -> bool)(
  cond(
    (token.kind == TokenKind.DocLineComment) => true,        // ///
    (token.kind == TokenKind.InnerDocLineComment) => true,   // //!
    (token.kind == TokenKind.DocBlockComment) => true,       // /** */
    (token.kind == TokenKind.InnerDocBlockComment) => true,  // /*! */
    true => false
  )
);
```

and `is_whitespace_or_regular_comment_` at `:78-85` classes
`TokenKind.SingleLineComment` (`//`) and `TokenKind.MultiLineComment` (`/* */`)
as skippable noise. That split is correct and deliberate — an implementation note
should not become public API documentation. The bug is that these 22 comments are
API documentation written in the note form.

## The affected methods

`std/collections/priority_queue.yo` — the whole public surface:

| comment | method |
| --- | --- |
| `:28` `// Create an empty priority queue.` | `new` (`:29`) |
| `:32` `// Number of elements.` | `len` (`:33`) |
| `:36` `// True if empty.` | `is_empty` (`:37`) |
| `:40` `// Inspect the smallest element without removing it.` | `peek` (`:41`) |
| `:47` `// Insert a new element.` | `push` (`:48`) |
| `:68` `// Remove and return the smallest element.` | `pop` (`:69`) |

`std/collections/deque.yo`:

| comment | method |
| --- | --- |
| `:32` | `new` (`:33`) |
| `:36` | `len` (`:37`) |
| `:40` | `is_empty` (`:41`) |
| `:44` | `_grow` (`:45`) — private, may stay `//` |
| `:83` | `push_back` (`:84`) |
| `:94` | `push_front` (`:95`) |
| `:108` | `pop_front` (`:109`) |
| `:123` | `pop_back` (`:124`) |
| `:141` | `get` (`:142`) |

`std/collections/btree_map.yo`:

| comment | method |
| --- | --- |
| `:33` | `new` (`:34`) |
| `:37` | `len` (`:38`) |
| `:41` | `is_empty` (`:42`) |
| `:45-46` | `_find` (`:47`) — private, may stay `//` |
| `:67` | `get` (`:68`) |
| `:75-76` | `insert` (`:77`) |
| `:97` | `remove` (`:98`) |

`btree_map.yo:109-113` and `:120` already use `///` for `first_entry` /
`last_entry` — those two are the only documented methods in the file, and they
are the model to follow.

The other six modules in `std/collections/` are clean: `array_list`,
`hash_map`, `hash_set`, `linked_list`, `ordered_map` and `entry` have zero
methods preceded by a plain `//` comment.

## Fix

Promote the 20 public-method comments from `//` to `///`. The two private
helpers (`_grow`, `_find`) may keep `//` — they are implementation notes and are
not part of the documented surface — but promoting them costs nothing and is more
consistent with `array_list.yo`, which documents its private helpers with `/** */`.

Multi-line cases keep every line prefixed: `btree_map.yo:45-46` (`_find`) and
`:75-76` (`insert`) are two-line comments, so both lines become `///`.

Run `yo fmt` on the three files afterwards.

## Worth fixing at the same time

Nothing in CI notices this. A `yo doc` lint — "an exported method whose
immediately preceding token is a `SingleLineComment`" — would have caught all 22
at authoring time and would keep the next module from repeating it. That is a
larger change than this fix and belongs in its own issue if the maintainer wants
it; the extractor already has the token classification it would need
(`src/doc/extractor.yo:66-85`).

## Regression test

`tests/internal/doc_extractor.test.yo` must gain a case asserting that a method preceded by `///` carries a
`doc` and one preceded by `//` does not — pinning the classification rule that
makes this an authoring error rather than a tool bug.

The 22 comments themselves are prose and are not unit-testable. Pin them the way
the rest of the doc surface is pinned: generate `yo doc std/collections --format
json` and assert that every **exported** method of `PriorityQueue`, `Deque` and
`BTreeMap` has a non-empty `doc`. That check is worth having for all of `std/`,
not just these three modules.
