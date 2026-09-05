# `vendor/markdown_yo`'s `punycode_encode` reads up to 3 bytes past its buffer — a heap over-read reachable from ordinary ASCII markdown

**Status:** OPEN (upstream — `vendor/markdown_yo`, submodule pinned
`9f9340f606572f049f8d568a47ef55af525cfd5d`, `v0.0.4-8-g9f9340f`). Found
2026-09-04 during the std-API-audit re-measurement of the D4 PR 9 row, while
auditing the vendor's hand-rolled UTF-8 decoders. Reproduced at runtime against
`yo 0.2.24`.
**Severity:** memory-unsafety — out-of-bounds heap READ, then the bytes read are
emitted into the rendered HTML.

**This does not need malformed input.** The source markdown is plain ASCII; the
malformed UTF-8 is *manufactured* by the vendor itself, which percent-decodes
the URL's domain into a fresh buffer and then decodes that buffer as UTF-8
without bounds checks. `%F0` at the end of a domain is enough.

Reachable from the shipped `yo` binary: `src/doc/render_html.yo:63`
(`markdown_to_html(text.clone(), &opts)`) renders every doc comment `yo doc`
processes, and `scripts/build_site.yo` renders the repo's `.md` files. The
reproducer below is confirmed under both `default_options()` and the exact
option set `src/doc/render_html.yo:44-60` builds.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ markdown_to_html, Options, default_options } :: import("../vendor/markdown_yo/src/lib.yo");

main :: (fn() -> unit)({
  (o : Options) = default_options();
  println(markdown_to_html(String.from("[l](http://a%F0/)\n"), &o));
});

export(main);
```

Under the ordinary allocator it does not crash — it silently emits whatever it
read:

```
$ YO_STD=$PWD/std yo compile repro.yo --optimize 2 -o repro.out && ./repro.out
<p><a href="http://xn--a�-/">l</a></p>

$ ./repro.out | od -An -tx1
 3c 70 3e 3c 61 20 68 72 65 66 3d 22 68 74 74 70 3a 2f 2f 78 6e 2d 2d 61 80 2d 2f 22
 3e 6c 3c 2f 61 3e 3c 2f 70 3e 0a 0a
```

The `href` contains a raw `0x80` byte, so the emitted HTML is not valid UTF-8.

Under macOS Guard Malloc, which places the allocation flush against a guard
page, the over-read faults:

```
$ DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MALLOC_STRICT_SIZE=1 ./repro.out
GuardMalloc[...]: Allocations will be placed on byte boundaries.
GuardMalloc[...]:  - Overrunning a buffer will cause an immediate crash. (Good.)
$ echo $?
139
```

`lldb` puts the fault in the four-byte UTF-8 decode arithmetic — the faulting
instruction is a `ldrb` feeding `lsl #18` / `lsl #12` / `lsl #6`, i.e.
`(b0-0xF0)*262144 + (b1-0x80)*4096 + (b2-0x80)*64 + (b3-0x80)`:

```
thread #2, stop reason = EXC_BAD_ACCESS (code=1, address=0x340394000)
  frame #0: repro.out`yo_id_125517 + 588
->  0x1000ccf98 <+588>: ldrb   w11, [x19, w11, sxtw]
    0x1000ccf9c <+592>: lsl    w12, w1, #18
    0x1000ccfa0 <+596>: add    w9, w12, w9, lsl #12
    0x1000ccfa4 <+600>: add    w9, w9, w10, lsl #6
```

**Control** — the identical program with a *valid* percent-encoded multibyte
domain runs clean under the same Guard Malloc settings and produces the correct
punycode:

```
$ ./control.out                      # "[l](http://a%C3%A3/)"
<p><a href="http://xn--a-yfa/">l</a></p>
$ DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MALLOC_STRICT_SIZE=1 ./control.out; echo $?
<p><a href="http://xn--a-yfa/">l</a></p>
0
```

Expected for the `%F0` case: the byte is not a valid UTF-8 sequence, so it
decodes to U+FFFD and the domain punycode-encodes that — no read past the
buffer, and no raw byte in the `href`.

## Root cause

`punycode_encode` (`vendor/markdown_yo/src/common/punycode.yo:166`) decodes its
input as UTF-8 with **no bounds checks at all**:

```rust
// vendor/markdown_yo/src/common/punycode.yo:173-190
while(p < len, {
  (b : i32) = i32((src.add(usize(p))).*);
  (cp : i32) = i32(0);
  if((b < i32(0x80)), {
    cp = b;
    p = (p + i32(1));
  }, if(((b >= i32(0xC0)) && (b < i32(0xE0))), {
    cp = (((b - i32(0xC0)) * i32(64)) + (i32((src.add(usize((p + i32(1))))).*) - i32(0x80)));
    p = (p + i32(2));
  }, if(((b >= i32(0xE0)) && (b < i32(0xF0))), {
    cp = (… (src.add(usize((p + i32(1))))) … (src.add(usize((p + i32(2))))) …);
    p = (p + i32(3));
  }, {
    cp = (… (p + i32(1)) … (p + i32(2)) … (p + i32(3)) …);
    p = (p + i32(4));
  })));
```

The loop condition only checks `p < len`; the continuation bytes at `p+1`,
`p+2`, `p+3` are read unconditionally. **Every other decoder in the vendor
guards these reads** — `src/inline/link.yo:304-321` and
`src/block/reference.yo:40-57` gate each arm on `(p+1) < end` / `(p+2) < end` /
`(p+3) < end`, and `src/common/normalize_link.yo:181-212` and `:443-520` gate
theirs too. `punycode.yo` is the one that does not.

Two things widen the reach beyond "invalid input":

1. **The malformed byte is manufactured, not supplied.**
   `src/common/normalize_link.yo:250-273` detects a percent-escape `>= 0xC0` in
   the domain (`:243`), percent-decodes the domain into a **fresh**
   `ArrayList(u8)` (`domain_bytes`, `:252-269`), and hands that buffer straight
   to `encode_domain(dbp, domain_bytes.len())` (`:271`). Nothing validates that
   the decoded bytes form complete UTF-8 sequences, and because the buffer is
   freshly allocated and exactly domain-sized, the over-read leaves the
   allocation rather than merely straying into the rest of the document.
   `encode_domain` (`src/common/punycode.yo:286`) then slices out a label with
   `str.from_raw_parts` (`:305`) and calls `punycode_encode` on it (`:306`).
2. **The final arm is an `else`, not a range test.** Any byte that is not
   `< 0x80`, not `0xC0..0xDF`, and not `0xE0..0xEF` lands in the four-byte arm —
   including a bare continuation byte `0x80..0xBF` and the never-valid
   `0xF8..0xFF`. So `%80` at the end of a domain triggers the same 3-byte
   over-read as `%F0`, and `_has_non_ascii` (`punycode.yo:299`) is satisfied by
   either.

## Fix

In the upstream repository (`github.com/shd101wyy/markdown_yo`), give
`punycode_encode`'s decoder the bounds guards its five siblings already have,
and make the lead-byte classification total:

```rust
}, if(((b >= i32(0xC0)) && (b < i32(0xE0)) && ((p + i32(1)) < len)), {
  …
}, if(((b >= i32(0xE0)) && (b < i32(0xF0)) && ((p + i32(2)) < len)), {
  …
}, if(((b >= i32(0xF0)) && (b < i32(0xF8)) && ((p + i32(3)) < len)), {
  …
}, {
  cp = i32(0xFFFD);      // truncated, continuation-only, or 0xF8..0xFF
  p = (p + i32(1));
}))));
```

U+FFFD (not the lead byte's own value) is the correct fallback — the same
correction the sibling decoders need, see
`issues/vendor-markdown-truncated-utf8-aliases-a-valid-link-label.md`.

The durable fix is the dedup this bug was found under: one bounds-checked,
width-returning decoder in `src/common/utils.yo` that all six call sites use, so
a guard can only be forgotten in one place —
`issues/vendor-markdown-shared-utf8-codec-has-no-callers.md`. Do it inside the
vendor rather than by importing `std/encoding/utf8` (reasons in that issue).

Then bump the submodule pointer in this repo and re-green the three site-build
legs (`.github/workflows/{test,deploy-site,release}.yml`).

## Regression test

Upstream, in `markdown_yo`'s fixture suite: `[l](http://a%F0/)` and
`[l](http://a%80/)` must render with a U+FFFD-derived punycode label and no raw
non-UTF-8 byte in the `href`. Run the case under Guard Malloc
(`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MALLOC_STRICT_SIZE=1`) or
ASan-on-Linux, red-first — under the ordinary allocator the bug is invisible
because the over-read lands in allocator slack.

Note for anyone verifying on this machine: `--sanitize address` does **not**
instrument here, so Guard Malloc is the tool that works.

Nothing new is needed in this repo's `tests/`; the submodule bump rides the
existing doc-pipeline legs.
