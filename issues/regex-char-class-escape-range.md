# Regex: Character class escape followed by range not parsed correctly

## Status: FIXED

## Problem

In the regex engine's character class parser, when a single-character escape (like `\0`, `\n`, `\t`) appeared before a dash `-` to form a range (e.g., `[\0- ]`), the escape was treated as a standalone codepoint and the dash was parsed separately. This meant `[\0- ]` did NOT create a range from U+0000 to U+0020 — instead it matched only `\0`, `-`, and ` ` individually.

## Example

```rust
// Before fix:
re := Regex.new(`[^\0- ]+`, ``).unwrap();
// "hello\nworld" matched as one string (newline not excluded!)

// After fix:
// "hello\nworld" correctly stops at "hello" (newline 0x0A is in range 0x00-0x20)
```

## Root Cause

In `std/regex/parser.yo`, the `_parse_char_class_content` function handled backslash escapes by calling `_parse_class_escape()` and adding all returned ranges directly to the class. It never checked for a following `-` to form a range, unlike the non-escape branch which called `_try_parse_char_range`.

## Fix

After `_parse_class_escape()` returns a single-codepoint range (i.e., exactly one range where `low == high`), delegate to `_try_parse_char_range` to check for a following `-` and form a proper range.

Multi-range escapes (`\d`, `\w`, `\s`) are unaffected since they return multiple ranges.

## Also Missing: `\xHH` hex escape support

The regex engine does not support `\xHH` hex escapes (e.g., `\x00`, `\x20`). Characters like `\x` are treated as literal `x`. Workaround: use `\0` for null, `\n` for newline, `\t` for tab, or literal characters.
