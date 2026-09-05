# `Writer.write_padded` measures the text in bytes but pads in runes, so neither unit comes out right

**Found**: 2026-09-04, by the std-API-audit coverage read — `write_padded` is an
exported, documented formatting entry point with no consumer and no test
anywhere in the tree, and it disagrees with the sibling padding routine in
`std/fmt/spec.yo` that IS used. **Class**: wrong-value. **Status**: OPEN.

## Symptom

`std/fmt/writer.yo:145-184`:

```rust
/// Append a str padded to width using the given pad rune and alignment.
write_padded : (fn(self : Self, s : str, width : usize, pad : rune, align : Alignment) -> Self)({
  len := s.len();                       // BYTES  (writer.yo:147)
  cond(
    (len >= width) => self.write_str(s),
    true => {
      padding := (width - len);         // a byte deficit …
      …
      while(i < padding, i = (i + usize(1)), {
        self.write_rune(pad);           // … spent one RUNE at a time (writer.yo:158/164/173/178)
      });
```

`s.len()` on a `str` is the byte length — it lowers to the `str` struct's `.len`
field (`src/codegen/exprs/inline_fns.yo:203-208` emits `(x.len)`), i.e. a byte
count. `write_rune` appends a whole UTF-8 sequence
(`utf8.encode_into`, `writer.yo:71-74`). So the deficit is computed in bytes and
paid in runes, and the result satisfies neither definition of "width".

## Reproducer

```rust
{ Writer, Alignment } :: import("std/fmt/writer");
{ rune } :: import("std/string/rune");
{ println } :: import("std/fmt");
open(import("std/string"));

rune_count :: (fn(s : String) -> usize)({
  b := s.as_bytes();
  n := usize(0);
  i := usize(0);
  while(runtime(i < b.len()), {
    cond(((b(i) & u8(192)) != u8(128)) => { n = (n + usize(1)); }, true => ());
    i = (i + usize(1));
  });
  n
});

show :: (fn(label : str, out : String) -> unit)(
  println(`${label}: [${out}] bytes=${out.len()} runes=${rune_count(out)}`)
);

main :: (fn() -> unit)({
  show("ASCII  s='ab'  width=5 pad=' '  Right", Writer.new().write_padded("ab", usize(5), rune(u32(32)), Alignment.Right).to_string());
  show("UTF-8  s='e-acute' width=5 pad=' ' Right", Writer.new().write_padded("é", usize(5), rune(u32(32)), Alignment.Right).to_string());
  show("UTF-8  s='naive' width=8 pad=' ' Left", Writer.new().write_padded("naïve", usize(8), rune(u32(32)), Alignment.Left).to_string());
  show("ASCII  s='ab' width=6 pad=BOX-DRAW Right", Writer.new().write_padded("ab", usize(6), rune(u32(0x2500)), Alignment.Right).to_string());
  show("UTF-8  s='e-acute' width=5 pad=' ' Center", Writer.new().write_padded("é", usize(5), rune(u32(32)), Alignment.Center).to_string());
});
export(main);
```

Observed (`yo compile … --optimize 2`, yo 0.2.24, `YO_STD=./std`):

```
ASCII  s='ab'  width=5 pad=' '  Right: [   ab] bytes=5 runes=5
UTF-8  s='e-acute' width=5 pad=' ' Right: [   é] bytes=5 runes=4
UTF-8  s='naive' width=8 pad=' ' Left: [naïve  ] bytes=8 runes=7
ASCII  s='ab' width=6 pad=BOX-DRAW Right: [────ab] bytes=14 runes=6
UTF-8  s='e-acute' width=5 pad=' ' Center: [ é  ] bytes=5 runes=4
```

Expected (width as a character count, which is what the doc comment and every
other padding API mean): `runes=5`, `runes=5`, `runes=8`, `runes=6`,
`runes=5` — i.e. the second, third and fifth rows are **one column short**
because the non-ASCII character was counted twice. Row 4 shows the other half of
the same defect: with a 3-byte pad rune the field is 6 runes but **14 bytes**, so
the byte reading is violated too. There is no interpretation of `width` under
which all five rows are correct.

The `.Center` arm's left/right split (`writer.yo:169-170`) has never executed in
any build of this tree — nothing calls `write_padded`.

## Root cause

`std/fmt/writer.yo:147` uses `s.len()` (bytes) as the measurement, while
`writer.yo:158`, `:164`, `:173` and `:178` spend the resulting deficit in calls
to `write_rune` (one code point each). `str` is a fat pointer over static
bytes, so `s.len()` has always been a byte count — the two units agree for
ASCII, which is all `write_padded` has ever been given, and the function has
never had a test to say otherwise.

The tree already contains the correct implementation of the same idea, and it
says so explicitly. `_apply_width` in `std/fmt/spec.yo:66-98` — the routine
behind `FormatSpec.pad`, which the real formatter uses — measures with
`text.chars().count()` under this comment:

```rust
// `width` is a CHARACTER count (the field doc says so, and Rust counts
// chars here too), so the measurement is a rune count — otherwise
// D4's byte flip would silently start padding `é` to two columns.
```

That is the same hazard, already diagnosed and fixed once, in a sibling module
that imports `Alignment` from this very file (`std/fmt/spec.yo:19`).
`Writer.write_padded` was simply missed.

## Fix

Make `write_padded` measure in runes, matching `_apply_width`:

```rust
len := String.from(s).chars().count();
```

(or an equivalent count that does not allocate — a loop over `s.bytes(i)`
counting bytes whose top two bits are not `10`). The padding loops already emit
one rune per unit, so nothing else changes and the ASCII behaviour is identical.

**Why runes and not bytes**: the doc comment says "padded to `width`", the
sibling `_apply_width` already commits the module to a character count with a
comment explaining why, Rust's `{:>N}` counts chars, and a byte-width field is
useless for the thing padding is for (lining up columns). Display *columns*
(wcwidth — East Asian wide characters, combining marks) would be more correct
still, but that needs a width table std does not have and would diverge from
`_apply_width`; do not do it here.

**The alternative — drop `write_padded` and let `FormatSpec.pad` be the one
padding API** — is a legitimate §6 dead-surface deletion (zero consumers, zero
tests). But `Alignment` must stay exported either way, because `std/fmt/spec.yo`
and `std/fmt/format.yo` both import it, and a `Writer` that cannot pad is an odd
shape for a string builder. Recommend fixing over deleting; the fix is one line.

## Regression test

`std/fmt/writer.yo` has **no test file at all** — no file under `tests/`
imports `std/fmt/writer` (`grep -rln 'fmt/writer' tests` is empty), and
`tests/fmt.test.yo` / `tests/format_specs.test.yo` both go through `std/fmt`
and `FormatSpec`, i.e. through the *correct* `_apply_width`. Create
`tests/fmt_writer.test.yo` (a new top-level file, mirroring
`tests/format_specs.test.yo` — do not open a `tests/fmt/` directory next to the
existing `tests/fmt.test.yo`) and cover the module's exported surface, red
first for the padding cases:

- `write_padded pads to a character width, not a byte width` — `"é"` to width 5
  must produce 4 pad runes (5 characters total), `"naïve"` to width 8 must
  produce 3, and the ASCII baseline `"ab"` to width 5 must produce 3 (this one
  passes today — keep it, it is the guard against over-correcting).
- `write_padded with a multi-byte pad rune` — `"ab"` to width 6 padded with
  `U+2500` must be 4 pad runes, i.e. 6 characters and 14 bytes.
- `write_padded Center splits the deficit left-biased` — the `.Center` arm has
  never run; pin `left = padding / 2` and `right = padding - left`.
- `write_padded returns the input unchanged when it is already at least width` —
  the `(len >= width)` early-out, which must also be measured in characters.
