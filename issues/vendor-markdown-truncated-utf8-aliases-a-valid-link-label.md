# `vendor/markdown_yo` decodes a truncated UTF-8 sequence as the lead byte's own value, so an invalid link label aliases a valid one

**Status:** OPEN (upstream — `vendor/markdown_yo`, submodule pinned
`9f9340f606572f049f8d568a47ef55af525cfd5d`, `v0.0.4-8-g9f9340f`). Found
2026-09-04 during the std-API-audit re-measurement of the D4 PR 9 row.
Reproduced at runtime against `yo 0.2.24`.
**Severity:** wrong-value. The two decoders named here are bounds-safe — every
read is guarded — but a malformed link label resolves to a *different,
well-formed* label's destination. (The vendor's sixth decoder,
`src/common/punycode.yo`, is **not** guarded and over-reads the heap; that is a
separate, more severe issue —
`issues/vendor-markdown-punycode-encode-reads-past-the-buffer.md`.)

This is shipped code, not a side project: `src/doc/render_html.yo:41` imports
`vendor/markdown_yo/src/lib.yo`, which reaches `src/doc_command.yo:33` and
`src/main.yo`, so the vendor closure compiles into the `yo` binary;
`scripts/build_site.yo` imports it too.

## Reproducer

The link reference *definition* uses the valid two-byte `ã` (`C3 A3`); the link
reference *usage* uses a bare `C3` — a truncated lead byte with no continuation.
They are different labels and must not match.

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ markdown_to_html, Options, default_options } :: import("../vendor/markdown_yo/src/lib.yo");

_push_str :: (fn(out : ArrayList(u8), s : str) -> unit)({
  b := String.from(s).as_bytes();
  (i : usize) = usize(0);
  while(i < b.len(), {
    _ := out.push(b.get(i).unwrap_or(u8(0)));
    i = (i + usize(1));
  });
});

main :: (fn() -> unit)({
  bytes := ArrayList(u8).new();
  _push_str(bytes, "[");
  _ := bytes.push(u8(0xC3));
  _ := bytes.push(u8(0xA3));            // definition label: valid "ã"
  _push_str(bytes, "]: /valid-target\n\nlink: [");
  _ := bytes.push(u8(0xC3));            // usage label: truncated lead byte
  _push_str(bytes, "]\n");
  src := String.from_bytes(bytes);      // unvalidated, by design (std/string/string.yo:77)
  (o : Options) = default_options();
  html := markdown_to_html(src, &o);
  println(html);
});

export(main);
```

```
$ YO_STD=$PWD/std yo compile repro.yo --optimize 2 -o repro.out && ./repro.out
<p>link: <a href="/valid-target">�</a></p>
```

(The `�` is the terminal rendering a lone `0xC3` — the anchor text is that
raw byte. `od -An -tx1` on the output shows `3e c3 3c` for `>`, the byte, `<`.)

Expected: the truncated label decodes to U+FFFD, which matches no definition, so
the reference stays literal text — the same shape an undefined label produces.
The control, with the usage label changed to the undefined `[x]`, is:

```
<p>link: [x]</p>
```

## Root cause

Both copies of `_normalize_label` — `vendor/markdown_yo/src/inline/link.yo:285`
(reference *usage*, called at `:736`) and
`vendor/markdown_yo/src/block/reference.yo:21` (reference *definition*, called
at `:654`) — carry a byte-for-byte identical hand-rolled UTF-8 decoder. Each
multibyte arm guards its reads and then, when the sequence would run past the
label's `end`, falls back to the lead byte's own numeric value:

```rust
// vendor/markdown_yo/src/inline/link.yo:306-310 (and :311-315, :316-320)
}, if(((ch_byte >= i32(0xC0)) && (ch_byte < i32(0xE0))), {
  if(((p + i32(1)) < end), {
    cp = (((ch_byte - i32(0xC0)) * i32(64)) + (i32((src.add(usize((p + i32(1))))).*) - i32(0x80)));
    bytes_consumed = i32(2);
  }, { cp = ch_byte; });          // ← truncated: cp becomes the LEAD BYTE
```

The same fallback is at `link.yo:310`, `:315`, `:320`, `:321` and at
`reference.yo:46`, `:51`, `:56`, `:57`. The bounds guards themselves are
correct — a 2-byte form needs `(p+1) < end`, a 3-byte form `(p+2) < end`, a
4-byte form `(p+3) < end`, which is exactly what is written — so nothing reads
out of bounds. `bytes_consumed` also stays `1`, so any continuation bytes that
*are* present get decoded as their own Latin-1 code points on the next
iteration. `src/common/normalize_link.yo:181-212` and `:443-520` guard their
reads the same way; `src/common/punycode.yo:173-190` does not, which is the
memory-safety issue filed separately.

The aliasing then comes from the Unicode case fold `_normalize_label` applies
after decoding. A truncated `0xC3` becomes U+00C3 `Ã`, whose lowercase is
U+00E3 `ã`, which re-encodes to `C3 A3` — byte-identical to the *valid* `ã`
label's normalized key. The invalid usage and the valid definition therefore
hash to the same reference key and the link resolves. Most lead bytes in
`0xC0..0xDF` have this property, because Latin-1's uppercase block sits exactly
where UTF-8's two-byte lead bytes do.

Note the vendor's own shared helper gets this right and is never called:
`vendor/markdown_yo/src/common/utils.yo:130` `read_utf8_codepoint` falls through
its three guarded arms to `i32(0xFFFD)`. See
`issues/vendor-markdown-shared-utf8-codec-has-no-callers.md` — the two issues
have one natural joint fix.

## Fix

In the upstream repository (`github.com/shd101wyy/markdown_yo`), replace the
`{ cp = ch_byte; }` fallbacks with the replacement character:

```rust
}, { cp = i32(0xFFFD); bytes_consumed = i32(1); });
```

at `src/inline/link.yo:310`, `:315`, `:320`, `:321` and
`src/block/reference.yo:46`, `:51`, `:56`, `:57`. `bytes_consumed = 1` is
already the initial value and is correct: advancing one byte at a time over a
malformed run is what a lossy decoder does, and it keeps the loop's `p < end`
termination obvious.

The right way to land it is to stop having two copies at all — route both
`_normalize_label`s through a single corrected decoder in
`src/common/utils.yo`, which is the subject of the companion issue and is what
D4 PR 9 (`plans/STD_API_AUDIT_D4_PLAN.md:461`) asked for. Do that **inside the
vendor**, not by importing `std/encoding/utf8`: the std route would make an
independent markdown library hard-depend on one Yo std module for a 40-line
codec, and `std/encoding/utf8.yo`'s `decode_parts` (`:186-233`) is RFC-3629
**strict** where the vendor is deliberately lax (it accepts `0xC0`/`0xC1`
overlongs and never validates continuation bytes), so it would change behaviour
on far more inputs than this one.

Then bump the submodule pointer here and re-green the three site-build legs
(`.github/workflows/{test,deploy-site,release}.yml`, which build the vendor with
`YO_STD=$GITHUB_WORKSPACE/std`).

## Regression test

Upstream, in `markdown_yo`'s fixture suite: a case whose link-reference label
ends in a truncated multibyte sequence, asserting the reference does **not**
resolve. Baseline the whole existing fixture suite before and after — this is
the one place the vendor's laxness is observable, and a "fix" that silently
changes other fixtures is a different change.

In this repo, the submodule bump is covered by the existing doc-pipeline legs;
no new `tests/` case is needed, because the vendor is a submodule and its
behaviour is not this repo's to pin.
