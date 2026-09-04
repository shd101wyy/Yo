# `String.parse_f64` answers `.None` for `1.5`, `0.5`, `100`, `1e3`, `1.234567`

**Severity: wrong value in a shipped API.** `parse_f64` landed in #398 and was
announced as a v0.2.24 headline feature ("`parse_f64` (Rust grammar
validation)"). It rejects most of the numbers anyone would actually write.

**Found** 2026-09-04 by the std-audit coverage re-measurement. The test file
`tests/string/string_parse.test.yo` had **zero** `parse_f64` cases, so nothing
caught it — the same shape as C34 (`json_parse` reading `"<html>"` as `0`
because the number path had no negative test).

## Reproducer

```rust
{ println } :: import("std/fmt");
open(import("std/string"));
_show :: (fn(s : str) -> unit)({
  r := String.from(s).parse_f64();
  match(r, .Some(v) => println(`  ${s} -> Some(${v})`), .None => println(`  ${s} -> NONE`))
});
main :: (fn() -> unit)({
  _show("1.5"); _show("0.5"); _show("100"); _show("1e3");
  _show("2.5"); _show("0.0"); _show("-1.5"); _show("1.234567");
  _show("1.25"); _show("42"); _show("3.14159");
});
export(main);
```

Under v0.2.24 (`yo compile pf64.yo --optimize 2`):

```
  1.5 -> NONE          1.25    -> Some(1.25)
  0.5 -> NONE          42      -> Some(42)
  100 -> NONE          3.14159 -> Some(3.14159)
  1e3 -> NONE
  2.5 -> NONE
  0.0 -> NONE
  -1.5 -> NONE
  1.234567 -> NONE
```

## Root cause

`_f64_grammar_ok` (`std/string/string.yo`) checks the `inf` / `nan` /
`infinity` words before the numeric grammar, and **both word arms return
unconditionally**:

```rust
cond(
  (rest == usize(3)) => {
    a := _lc_ascii(bytes(i)); b := ...; c := ...;
    return(                               // <-- always returns
      ((a == u8(0x69)) && ...) || ((a == u8(0x6E)) && ...)
    );
  },
  (rest == usize(8)) => {
    ... build `ok` for "infinity" ...
    return(ok);                           // <-- always returns
  },
  true => ()
);
// numeric grammar below — unreachable for rest == 3 and rest == 8
```

`rest` is the length after an optional sign. So **any** 3-byte remainder that
is not `inf`/`nan` returns `false`, and any 8-byte remainder that is not
`infinity` returns `false` — the numeric grammar below is unreachable for those
two lengths. `1.5`, `0.5`, `2.5`, `0.0`, `100`, `1e3` are 3 bytes; `-1.5` is a
sign plus 3; `1.234567` and `12345678` are 8. `1.25` (4) and `3.14159` (7) take
the normal path and work, which is why the bug looked like "some floats fail".

## Fix

The word arms may only return when the word actually matches; a non-matching
3- or 8-byte remainder must fall through:

```rust
(word : bool) = (((a == u8(0x69)) && ...) || ((a == u8(0x6E)) && ...));
if(word, { return(true); });
```

Falling through is safe for rejection too: `abc` reaches the numeric grammar,
finds no digits, and answers `.None` there.

## Regression tests

`tests/string/string_parse.test.yo` gained five `parse_f64` tests — the
three-byte set, the signed-remainder set, the eight-byte set, an inf/nan/infinity
guard, and a rejection guard (whitespace, hex floats, garbage suffixes,
`infx`, `infinit`, `infinityy`, `nanana`, `.`, `1e`, `1.2.3`).

**Verified RED first**: on the shipped v0.2.24 binary the three acceptance
tests fail while the two guard tests pass — i.e. the fix adds acceptance
without loosening any rejection.

**FIXED 2026-09-04.**
