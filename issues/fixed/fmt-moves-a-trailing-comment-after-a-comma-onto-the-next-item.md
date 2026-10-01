# `yo fmt` moved a trailing comment after a comma onto the next item, and dropped the blank line after a comment

**Severity:** S2 — `yo fmt` rewrote `a : bool, // why` so the comment sat above
the NEXT field, silently re-attaching every trailing field comment in a
commented struct, and erased every blank line that followed a comment.

**Status: FIXED** (2026-10-01, `src/formatter.yo`). Found formatting
`markdown_yo` (a dependency of the compiler) for a CI `yo fmt --check` step: the
v0.2.47 formatter re-attached 284 comment lines and deleted 257 blank lines
there. Measured with v0.2.47 and a develop-built formatter (5567a7796); both
behave the same.

## Symptom

```rust
// Header.

{ String } :: import("std/string");

Opts :: struct(
  html : bool,      // allow raw HTML
  breaks : bool,    // \n becomes <br>
  max_nesting : i32 // nesting cap
);
```

formatted to

```rust
// Header.
{ String } :: import("std/string");

Opts :: struct(
  html : bool,
  // allow raw HTML
  breaks : bool,
  // \n becomes <br>
  max_nesting : i32 // nesting cap
);
```

Only the last field kept its comment, because no comma came before it. The
blank line after a file header or a `// ---- section ----` banner was deleted,
and so was the blank line after a statement with a trailing comment
(`a := x; // first` followed by a blank line).

## Root cause (measured)

Two places in the token loop of `format_yo_source`:

1. **The comma branch.** In a multi-line list it writes `,` plus a newline
   without looking at the next token. A line comment on the comma's own row
   therefore starts on a fresh line, where it reads as the leading comment of
   the next item. The semicolon branch already had the right rule
   (`emit_newline` is false when the next token is a comment on the same row);
   the comma branch did not.
2. **The line-comment branch.** It always ends the comment with exactly one
   `\n`. The rule that keeps at most one blank line between statements lives in
   the semicolon branch, which a comment never goes through, so any blank line
   after a comment was lost.

## Fix

- The comma branch skips its line break when the next token is a line comment
  on the comma's row. The comment handler writes the newline after the comment.
- The line-comment branch writes one blank line when the next token is two or
  more rows below it, except before a closer (`)`, `]`, `}`). This matches the
  statement separator's "at most one blank line".

Blank lines between the items of an argument list are still dropped, comment
or not: that is the list policy, and this fix leaves it alone.

The new formatter changes nothing in this tree: all 1,150 `.yo` files under
`src/`, `std/` and `tests/` format to themselves, and so do the `fmt-write` and
`fmt-check` CLI fixtures. No existing formatted file ever contained either
shape, because the old formatter had already removed them.

## Regression test

`tests/internal/formatter_fixtures/94_keeps_a_trailing_comment_after_a_comma_and_the_blank_after_a_comment.{input,expected}`,
run by the fixture-corpus test in `tests/internal/formatter.test.yo`. The old
formatter gets the fixture wrong in exactly the two ways above, and the fixed
one formats it unchanged and idempotently.
