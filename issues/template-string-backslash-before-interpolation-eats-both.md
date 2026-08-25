# A literal backslash immediately before `${…}` in a template string eats the backslash AND silently disables interpolation

**Status: OPEN.** Found 2026-08-25 while writing `RegexError`'s `ToString`
messages for `std/regex` (STD_API_AUDIT D8). Silent wrong output — no error, no
warning; the message shipped as `backreference '${group}' exceeds …` instead of
`backreference '\1' exceeds …` and only a runtime read of the printed string
caught it.

## Symptom

In a backtick template string, `\\` is the escape for one literal backslash. It
works everywhere **except** immediately before an interpolation:

```rust
open(import("std/string"));
open(import("std/fmt"));
main :: (fn() -> unit)({
  n := usize(7);
  println(`A: ${n}`);
  println(`B: \\${n}`);
  println(`C: \\ ${n}`);
  println(`D: \\x${n}`);
});
export(main);
```

```
A: 7
B: ${n}        <-- WRONG: expected `B: \7`
C: \ 7
D: \x7
```

`B` loses the backslash *and* prints the interpolation source text verbatim.
`C` and `D` — the same escape with any character between it and the `$` — are
correct, which is what isolates the adjacency as the trigger.

## Root cause

`src/lexer.yo`'s template scanner (the `while(k < n, …)` loop at ~line 403)
decodes escapes into a `StringBuilder` whose contents are handed on to the
template parser, and it uses **two different encodings that collide**:

- `\\` → `ts_sb.write_rune(rune(u32(0x5C)))` — one raw backslash
  (`src/lexer.yo:430-433`).
- `\$` → `ts_sb.write_str("\\$")` — backslash **kept**, as the marker that tells
  the later template parser "this `$` is escaped, do not interpolate"
  (`src/lexer.yo:415-418`).

So both `\$` (escaped dollar) and `\\$` (literal backslash, then a real
interpolation) reduce to the identical two-character payload `\$`. The template
parser then reads the second one as an escaped dollar: it drops the backslash
and emits `${n}` as literal text.

The consumer is `src/parser.yo:376-384`, the "Escaped dollar: `\\$` → `$`"
branch of the template splitter: it writes a bare `$` and advances `i` by 2,
past the `$`. The `{n}` that follows is therefore never seen as an
interpolation opener and is copied out as literal text — which is exactly the
observed `B: ${n}`.

The bug is the encoding, not either branch on its own — the "escaped dollar"
marker is not distinguishable from a genuine backslash that happens to land in
front of a `$`.

## Fix sketch (not applied here)

Escape the marker: when `\\` produces a literal backslash and the next source
character is `$`, the lexer must emit an escaped form the template parser
decodes back to one backslash (e.g. write `\\\\` and teach the template parser
that `\\\\` → `\`), or switch the payload from an in-band marker to an
out-of-band segment list so no character sequence is overloaded.

## Workaround in use today

Reword the message so no backslash sits directly in front of an interpolation
(`std/regex/error.yo` says `backreference to group ${group}` rather than
`backreference '\${group}'`).

## Test to add with the fix

`tests/template_string.test.yo` (or the closest existing template-string file):
assert `` `\\${n}` `` renders `\7` for `n := usize(7)`, alongside the `\\ ` and
`\\x` cases that already work, so the adjacency is pinned.
