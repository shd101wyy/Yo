# A real newline inside a double-quoted string reports as "Adjacent different operators (near :)" — far from the cause

**Status: OPEN** (found 2026-09-03 during the error-diagnostics P2 work; the
diagnostic misdirection is the bug — whether `""` strings should span lines is
a design question).

## Reproducer

```rust
x : str = "line1
line2";
```

```bash
yo check /tmp/mls.yo
# error: Adjacent different operators need parentheses to clarify grouping (near :).
#  --> /tmp/mls.yo:1:2
# 1 | x : str = "line1
```

## What goes wrong

The lexer ends the string literal at the newline; the rest of the line
(`line2";`) is lexed as identifiers/operators, and the FIRST confusing token
pair surfaces as the adjacent-operators error — at the `:` of the preceding
line's binding, with the caret on the string's opening line but the message
naming grouping, not the string. Anything multiline after that point in the
same file can instead fail as a downstream "unexpected token" — the reported
site and the cause can be arbitrarily far apart (a 25-entry registry data
file produced a mismatch error 400 lines away from the offending literal).

## Impact

Authoring data-heavy Yo (embedded snippets, examples, text blocks) via tools
that materialize `\n` as real newlines produces parse errors whose position
and text misdirect completely. Backtick templates span lines and are the
correct spelling today — but nothing tells you that when you hit this.

## Fix direction

Either (a) the lexer accepts newlines inside `""` (smallest change; matches
how C treats them, arguably surprising in the other direction), or (b) the
lexer errors on an unterminated `""` literal at end-of-line with "unterminated
string literal — did you mean a backtick template for multiline text?" — the
D8 did-you-mean pattern, one family in the P2 classifier
(E_UNTERMINATED, E0004).
