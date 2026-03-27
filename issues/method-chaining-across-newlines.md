# Method Chaining Across Newlines Fails

## Status: Fixed

## Problem

Method chaining across newlines fails to parse:

```rust
// FAILS — .add() on new line not parsed as member access
b := Builder.new()
  .add(`a`)
  .add(`b`);
```

Same-line chaining works fine:

```rust
// WORKS
b := Builder.new().add(`a`).add(`b`);
```

## Root Cause

In `src/parser.ts`, `parsePrimaryEnd()` (line 952-957) requires `!hasWhitespaceBackward` and `!hasWhitespaceForward` for member access via `.`. When a newline separates the previous expression from the dot, `hasWhitespaceForward` is `true` (because `skipWhitespace` skipped the newline + indentation), so the condition rejects it.

The parser already has an `isOperatorAtLineStart()` helper (line 806) that detects when an operator is at the beginning of a new line, but it was not used for dot member access.

## Fix

Added a `isDotAtLineStart` check in `parsePrimaryEnd()` that allows `.` as member access when:

1. The token is a dot
2. There's whitespace before it (from parsing forward)
3. No whitespace after it (i.e., `.field` not `. field`)
4. The whitespace contains a newline (not just spaces — this prevents `return .Ok()` from being parsed as member access)
5. `isOperatorAtLineStart()` confirms the dot is at the start of a new line

This preserves the existing behavior where `return .Ok(42)` (space between return and dot) is correctly parsed as a return expression, NOT as member access on `return`.

## Files Changed

- `src/parser.ts` — Added `isDotAtLineStart` condition in `parsePrimaryEnd()`; saved `originalIndex` before whitespace skipping
