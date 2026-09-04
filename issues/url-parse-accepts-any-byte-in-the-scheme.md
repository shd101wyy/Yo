# `Url.parse` accepts any byte in the scheme — its charset guard tests the first character over and over

## Status

**OPEN** — found 2026-09-04 while verifying the redirect-resolution defects
during the std-API audit re-measurement of the `url` row. **Severity:
wrong-value** (`scheme()` returns text that is not a scheme, and strings that
are not URIs parse as URIs). Reproduced at runtime with v0.2.24.

## Reproducer

```rust
open(import("std/string"));
{ Url, UrlError } :: import("std/url");
{ Error, AnyError, Exception } :: import("std/error");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(String.from("THREW"));
        unwind(());
      }
    )
  );
  v := Url.parse(String.from("foo bar!baz:qux/x"), exn);
  vs := v.scheme();
  vp := v.path();
  println(`bad scheme accepted: "${vs}" path="${vp}"`);
});
export(main);
```

```
$ yo compile repro.yo --optimize 2 -o repro.out && ./repro.out
bad scheme accepted: "foo bar!baz" path="qux/x"
```

Expected: `UrlError.MissingScheme` is thrown. `foo bar!baz` is not a scheme —
RFC 3986 §3.1 is `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, and
`std/url/index.yo:110` states that grammar in a comment on the parser itself.

`a/b:c` parses the same way, with scheme `a/b`.

## Root cause

`std/url/index.yo:118-142`. The first character is validated correctly:

```rust
// std/url/index.yo:119-125
first := s.byte_at(usize(0));
cond(
  (((first >= _LOWER_A) && (first <= _LOWER_Z)) || ((first >= _UPPER_A) && (first <= _UPPER_Z))) => (),
  true => {
    exn.throw(dyn(UrlError.MissingScheme));
  }
);
```

The loop that scans the rest then guards on `first` again instead of on the
current byte `ch`:

```rust
// std/url/index.yo:136 (reflowed)
(((((first >= _LOWER_A) && (first <= _LOWER_Z)) || ((first >= _UPPER_A) && (first <= _UPPER_Z)))
  || (((ch >= _LOWER_A) && (ch <= _LOWER_Z)) || ((ch >= _UPPER_A) && (ch <= _UPPER_Z))))
  || ((((ch >= _ZERO) && (ch <= _NINE)) || (ch == _PLUS)) || ((ch == _MINUS) || (ch == _DOT)))) => (),
true => {
  exn.throw(dyn(UrlError.MissingScheme));   // std/url/index.yo:137-139 — dead code
}
```

`first` was proven ALPHA a dozen lines above, so the first two disjuncts are
invariantly true and the whole guard is vacuous. The `true =>` arm can never
run: every byte up to the first `:` is accepted, whatever it is. The two
`first` disjuncts are a copy of the `ch` disjuncts that follow them — the
intended check is there, just unreachable behind them.

Nothing pins it. `tests/url/url.test.yo:209` ("Url parse missing scheme
returns error") passes `://example.com`, which fails on the *first*-byte check
at :121, so the loop's guard has no test at all.

## Why it matters beyond the odd value

Redirect resolution feeds this parser strings that are not absolute URLs.
`std/http/client.yo:219` classifies a `Location` as absolute when it merely
contains `://`, so a relative `Location: dash?next=https://app.example.com/x`
is handed to `Url.parse`, which — because of this bug — reports scheme
`dash?next=https` and host `app.example.com` instead of rejecting it. The
scheme-prefix scan that the `Url.join` work needs
(`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`)
must not be built on a validator that accepts anything.

## Fix

Delete the two `first` disjuncts at `std/url/index.yo:136`, leaving the
`ch`-based ALPHA / DIGIT / `+` / `-` / `.` test. That restores the documented
grammar and makes the `true =>` arm live.

While in this code, extract the scan into
`_scheme_prefix_len(s : String) -> Option(usize)` — "the length of a valid
`scheme ":"` prefix at the start of `s`, or `.None`" — and have `parse` call
it. RFC 3986 §5.2 reference resolution needs exactly that predicate, and one
implementation shared by `parse` and `join` is the point of the exercise.

## Regression test

`tests/url/url.test.yo`, next to the existing scheme tests: each of
`foo bar:baz`, `a/b:c`, `ht*tp://x`, a scheme containing a tab, and
`1http://x` (already covered by the first-byte rule — keep it explicit) must
throw
`UrlError.MissingScheme`, while `http`, `HTTP` (lowercased on the way out,
pinned at :104), `ftp`, `mailto`, `data`, `a+b-c.d:x` still parse.

## Breaking change

Yes, in the narrow sense that input which parses today starts throwing —
anything relying on `Url.parse("a/b:c")` succeeding breaks. That is the point
of the fix (the accepted values were garbage), but it is a behaviour change in
an exported std function and belongs in the release notes for the version that
ships it.
