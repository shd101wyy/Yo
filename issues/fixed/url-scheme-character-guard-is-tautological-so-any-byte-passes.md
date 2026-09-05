# `Url.parse`'s scheme-character guard tests the wrong byte, so it is always true and `"ht tp://x/"` parses

**Status: FIXED 2026-09-05** — The scheme-byte guard tested `first` (already known to be ALPHA) instead of `ch`, so its disjunction was always true; it now tests `ch`. The whole-input pre-scan from the sibling issue catches `"ht tp://x/"` before the scheme scan is even reached, so both layers now reject it.

**Found**: 2026-09-04, while verifying that `UrlError.InvalidCharacter` has no
producer (std-API-audit re-measurement, dead-public-surface row) — the scheme scan
is the *only* place in `std/url` that looks at individual characters, and it turns
out not to reject anything. Measured against `develop`
(`8d471c7df`) with `yo` 0.2.24 and `YO_STD=./std`.

**Class**: wrong-value (a validation guard that can never fail; the `throw` it
guards is dead code).

Distinct from
`url-parse-validates-no-characters-so-a-crlf-url-splits-the-http-request.md`:
that one is validation that was never written, this one is validation that *was*
written and is inoperative because of a wrong operand. Both live in
`Url.parse`, and fixing either does not fix the other.

## Reproducer

```rust
open(import("std/string"));
{ Url, UrlError } :: import("std/url");
{ Error, AnyError, Exception } :: import("std/error");
{ println } :: import("std/fmt");

_try :: (fn(src : String) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(`  -> THREW ${err.to_string()}`);
        unwind(());
      }
    )
  );
  println(`input: [${src}]`);
  u := Url.parse(src, exn);
  println(`  -> OK scheme=[${u.scheme()}]`);
});

main :: (fn(io : Io) -> unit)({
  println(`scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )   -- RFC 3986 3.1`);
  _try(String.from("ht tp://x/"));
  _try(String.from("ht_tp://x/"));
  _try(String.from("h!*()tp://x/"));
  _try(String.from("1http://x/"));
  _try(String.from("http://x/"));
});
export(main);
```

Observed, verbatim:

```
scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )   -- RFC 3986 3.1
input: [ht tp://x/]
  -> OK scheme=[ht tp]
input: [ht_tp://x/]
  -> OK scheme=[ht_tp]
input: [h!*()tp://x/]
  -> OK scheme=[h!*()tp]
input: [1http://x/]
  -> THREW URL error: missing scheme
input: [http://x/]
  -> OK scheme=[http]
```

Expected: the first three throw `UrlError.MissingScheme` (RFC 3986 §3.1 admits
only `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` before the `:`); the last two are
already right.

Note the fourth case: the FIRST-character check works. Only the per-byte loop
guard is inert, which is why the defect reads as "scheme validation exists" to
anyone who skims the function.

## Root cause

`std/url/index.yo:118-142`. The first byte is checked on its own:

```rust
// First char must be a letter
first := s.byte_at(usize(0));                                       // :119
cond(
  (((first >= _LOWER_A) && (first <= _LOWER_Z)) || ((first >= _UPPER_A) && (first <= _UPPER_Z))) => (),
  true => {
    exn.throw(dyn(UrlError.MissingScheme));                         // :123
  }
);
```

so past `:125`, `first` is **provably** an ASCII letter. The loop that scans the
rest of the scheme then re-tests `first` as the leading disjunct of its guard
(`std/url/index.yo:136`, reformatted here — it is one line in the file):

```rust
i := usize(1);
found_colon := false;
while(runtime(i < src_len), {
  ch := s.byte_at(i);                                               // :129
  cond(
    (ch == _COLON) => { scheme_end = i; found_colon = true; break; },
    (
      (
        (((first >= _LOWER_A) && (first <= _LOWER_Z))               // <-- always true
          || ((first >= _UPPER_A) && (first <= _UPPER_Z)))          // <-- always true
        || (((ch >= _LOWER_A) && (ch <= _LOWER_Z))
          || ((ch >= _UPPER_A) && (ch <= _UPPER_Z)))
      )
      || ((((ch >= _ZERO) && (ch <= _NINE)) || (ch == _PLUS))
        || ((ch == _MINUS) || (ch == _DOT)))
    ) => (),
    true => {
      exn.throw(dyn(UrlError.MissingScheme));                       // :138 — DEAD
    }
  );
  i = (i + usize(1));
});
```

The two `first`-based disjuncts are copy-paste residue from the `:121` check. Since
`first` is a letter there, `first >= _LOWER_A && first <= _LOWER_Z ||
first >= _UPPER_A && first <= _UPPER_Z` is `true`, the whole disjunction
short-circuits to `true`, the arm at `:136` always matches, and the
`true => throw MissingScheme` arm at `:137-139` is unreachable. The scan therefore
copies **every** byte up to the first `:` into the scheme, which
`std/url/index.yo:149-160` then lowercases and stores verbatim.

The only surviving scheme rejections are the first-byte ALPHA check (`:121`) and
"no colon found at all" (`:143-148`).

Consequences beyond the wrong error: `Url.origin()` (`std/url/index.yo:419`)
re-emits the stored scheme, `std/http/client.yo:113-124` compares it against
`http`/`https` (so a bogus scheme becomes `HttpError.UnsupportedScheme` — the right
class by luck, one hop later), and `_resolve_location`'s
`location.contains("://")` test (`std/http/client.yo:219`) treats
`"ht tp://evil"` as an absolute URL.

Coverage: `tests/url/url.test.yo` (25 tests) has no negative scheme case at all —
the only `MissingScheme` assertion is the `to_string` one at `:351`.

## Fix

Delete the two `first`-based disjuncts at `std/url/index.yo:136`. The guard becomes
exactly the RFC 3986 §3.1 tail set:

```rust
(
  (((ch >= _LOWER_A) && (ch <= _LOWER_Z)) || ((ch >= _UPPER_A) && (ch <= _UPPER_Z)))
    || ((((ch >= _ZERO) && (ch <= _NINE)) || (ch == _PLUS)) || ((ch == _MINUS) || (ch == _DOT)))
) => (),
```

That is the whole change — the `throw` at `:138` is already correct, and
`_LOWER_A`/`_UPPER_Z`/`_ZERO`/`_NINE`/`_PLUS`/`_MINUS`/`_DOT` are all already
defined (`std/url/index.yo:35-50`). Run `yo fmt std/url/index.yo` afterwards; the
guard is a single long line and the formatter owns its wrapping.

Do not "fix" this by replacing `first` with `ch` in those disjuncts — that yields
`ch` is-lower `|| ch` is-upper twice over, which is the same predicate written
twice and hides that the check was over-broad rather than mis-targeted.

## Regression test

`tests/url/url.test.yo`:

- **`Url parse rejects a non-scheme byte before the colon`** — assert that each of
  `"ht tp://x/"`, `"ht_tp://x/"`, `"h!tp://x/"`, `"ht%tp://x/"` and
  `"ht\ttp://x/"` throws `UrlError.MissingScheme`. Assert the *variant*, not just
  "something threw": `Url.parse` has four other rejections that would satisfy a
  bare did-it-throw check.
- **`Url parse accepts every legal scheme byte`** — the over-rejection canary:
  `"http://x/"`, `"HTTPS://x/"` (must still lowercase to `https`),
  `"a+b-c.d://x/"`, `"z9://x/"`, `"mailto:u@example.com"` and `"data:text/plain,hi"`
  (the two opaque forms already tested elsewhere in the file). This one must be
  verified GREEN **before** the fix, so it is a genuine baseline.

Verify the rejection test RED before the fix (it will report `OK scheme=[ht tp]`
where it expects a throw) and GREEN after. Then
`yo test ./tests/url/url.test.yo --parallel 1` and `yo test ./tests/http --parallel 1`
(`std/http/client.yo:24` imports this module).

## Breaking change

Yes, in the narrow sense that URLs whose scheme contains a byte RFC 3986 forbids
stop parsing and start throwing `UrlError.MissingScheme`. Since no such string is a
valid URL, and since the error type and message are unchanged, the release-note
line is one sentence: "`Url.parse` now rejects invalid characters in the scheme, as
its documentation always claimed."
