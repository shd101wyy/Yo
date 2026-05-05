# Bug: `@skip_prelude` literal in doc comments triggers false-positive prelude skip

## Status

**FIXED** in commits below. Tests in `yo-self/tests/evaluator_index.test.yo`
updated to assert the new (correct) behavior.

## Summary

`hasCommentAttribute` in `src/evaluator/index.ts` searches **all** comment tokens
(including `//!` inner doc comments and `///` outer doc comments) for the attribute
string. Any doc comment that merely _mentions_ `@skip_prelude` — e.g. to explain what
the attribute does — will cause the evaluator to treat the file as if `// @skip_prelude`
is present and evaluate it **without the standard prelude**.

## Reproduction

```rust
//! This file checks for `@skip_prelude` in the token stream.

// The token stream now contains an InnerDocLineComment token whose value
// includes the literal "@skip_prelude".  The evaluator sees this and skips
// loading the prelude.

main :: (fn() -> unit)({
  (found : bool) = false;
  result := (!(found));   // ERROR: Variable "!" not found — prelude was skipped
});
export main;
```

Running `yo-cli test` on a file that imports this module fails with:

```
Error: Variable "!" not found.
```

The error point (`!`) appears to be unrelated to the doc comment; the real cause
is that the prelude was not loaded, so all prelude-defined operators and types
(`!`, `str`, `Option`, …) are missing.

## Root Cause

In `src/evaluator/index.ts` (`evaluateProgram`):

```typescript
const skipPrelude = hasCommentAttribute(this.tokens, "@skip_prelude");
if (!skipPrelude && !SKIP_PRELUDE) {
  /* load prelude */
}
```

And `hasCommentAttribute` (same file):

```typescript
export function hasCommentAttribute(
  tokens: Token[],
  attribute: string
): boolean {
  return tokens.some(
    (token) => isCommentTokenKind(token.type) && token.value.includes(attribute)
  );
}
```

`isCommentTokenKind` returns `true` for `InnerDocLineComment` (`//!`),
`DocLineComment` (`///`), and multiline variants. Any doc comment that contains
the literal string `@skip_prelude` triggers the skip.

The `@skip_prelude` directive was intended for `//` plain single-line comments only
(or at least for non-doc comment tokens).

## Affected Files

- `yo-self/evaluator/index.yo` — had `//!   - Checking for \`@skip_prelude\`` in the
  module-level inner doc block; this accidentally triggered the skip.

## Workaround Applied

Changed the offending line in `yo-self/evaluator/index.yo` (later reverted
once the proper fix landed) from:

```
//!   - Checking for `@skip_prelude` in the token stream
```

to:

```
//!   - Checking for the skip-prelude directive in the token stream
```

This avoids the literal `@skip_prelude` string in a doc comment token.

## Fix Applied

`hasCommentAttribute` now excludes doc comment token kinds
(`InnerDocLineComment`, `DocLineComment`, `DocBlockComment`,
`InnerDocBlockComment`) when searching for control attributes like
`@skip_prelude`. Only plain `//` single-line and `/* */` block comments
are considered.

- TS: `src/evaluator/index.ts` `hasCommentAttribute`
- yo-self: `yo-self/evaluator/index.yo` `has_comment_attribute`

The yo-self workaround comment was reverted to the original wording, and
the four `evaluator_index.test.yo` cases that asserted the old (buggy)
"return true for doc comment" behavior were flipped to assert the new
correct "return false" behavior.

## Original Proper-Fix Notes

`hasCommentAttribute` should **exclude** doc comment token kinds
(`InnerDocLineComment`, `DocLineComment`, `DocBlockComment`,
`InnerDocBlockComment`) when searching for control attributes like `@skip_prelude`.
Only plain `//` single-line or `/* */` block comments should be considered.

Alternatively, require the attribute to appear on its own line as `// @skip_prelude`
(exact prefix match) rather than a substring search across all comment tokens.

Relevant source: `src/evaluator/index.ts` — `hasCommentAttribute` and
`isCommentTokenKind`.
