# `Url.parse` validates no characters — a URL with a raw CRLF splits the HTTP request it is fetched with

**Status: FIXED 2026-09-05** — `Url.parse` now pre-scans the whole input against the RFC 3986 §2 byte set (`_is_uri_byte`) and throws `UrlError.InvalidCharacter(pos)` at the first offending byte — the producer the variant never had. Verified 0/12 → 12/12 rejections with the over-rejection canary at 10/10 both before and after.

**Found**: 2026-09-04, by the std-API-audit re-measurement of the dead-public-surface
row (`UrlError.InvalidCharacter` is declared, documented and formatted, but nothing
in the tree ever produces it). Measured against `develop`
(`8d471c7df`) with `yo` 0.2.24 and `YO_STD=./std`.

**Class**: wrong-value / protocol corruption (a request-splitting sink), plus the
API lie that led here — the same shape as C34
(`issues/fixed/json-number-parser-accepts-invalid-and-any-garbage.md`), where a
declared-but-unconstructed error variant turned out to mark a validation step that
was never written.

Two symptoms, **one root cause**: `Url.parse` performs no character validation
anywhere outside the scheme, so `UrlError.InvalidCharacter` has no producer *and*
forbidden bytes flow through the parser untouched into `std/http`'s wire bytes.

## Symptom 1 — forbidden characters parse silently

`std/url/index.yo:1` claims "URL parsing and formatting per RFC 3986 (simplified)",
and the error enum publishes a positional variant for exactly this failure
(`std/url/index.yo:11`, `InvalidCharacter(pos : usize)`). Raw spaces and raw
control bytes — both forbidden by RFC 3986 §2, which admits only
`unreserved / gen-delims / sub-delims / "%" HEXDIG HEXDIG` — are accepted:

```rust
open(import("std/string"));
{ ArrayList } :: import("std/collections/array_list");
{ Url, UrlError } :: import("std/url");
{ Error, AnyError, Exception } :: import("std/error");
{ println } :: import("std/fmt");

main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(`THREW: ${err.to_string()}`);
        unwind(());
      }
    )
  );
  // A raw space is forbidden in a URI by RFC 3986 (it must be percent-encoded).
  u1 := Url.parse(String.from("http://exa mple.com/a b"), exn);
  println(`space-URL accepted: host=[${u1.host().unwrap()}] path=[${u1.path()}]`);
  // A raw control byte (0x01) is forbidden too: "http://a\x01b".
  b := ArrayList(u8).new();
  b.push(u8(104)); b.push(u8(116)); b.push(u8(116)); b.push(u8(112));
  b.push(u8(58)); b.push(u8(47)); b.push(u8(47));
  b.push(u8(97)); b.push(u8(1)); b.push(u8(98));
  u2 := Url.parse(String.from_bytes(b), exn);
  println(`control-byte-URL accepted: host_len=${u2.host().unwrap().len()}`);
  // The variant the enum publishes for exactly this case:
  e := UrlError.InvalidCharacter(pos : usize(9));
  println(`variant exists and stringifies: ${e.to_string()}`);
});
export(main);
```

Observed, verbatim:

```
space-URL accepted: host=[exa mple.com] path=[/a b]
control-byte-URL accepted: host_len=3
variant exists and stringifies: URL error: invalid character at position 9
```

Expected: both parses throw `UrlError.InvalidCharacter` at the offending byte
offset (10 and 8 respectively).

## Symptom 2 — the accepted CRLF is written straight onto the wire

This is the reason the missing validation is not merely cosmetic. `std/http`'s
client takes the parsed path (and query) and interpolates them into the HTTP/1.1
request line with no guard of its own, so a URL carrying a raw CRLF produces **two**
requests where the caller asked for one:

```rust
open(import("std/string"));
{ Url, UrlError } :: import("std/url");
{ HttpMethod, HttpRequest } :: import("std/http/http");
{ Error, AnyError, Exception } :: import("std/error");
{ println } :: import("std/fmt");

main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(`THREW: ${err.to_string()}`);
        unwind(());
      }
    )
  );
  // A raw CR LF inside the path is forbidden by RFC 3986 and is exactly what
  // UrlError.InvalidCharacter is declared for.
  u := Url.parse(String.from("http://example.com/a\r\nX-Injected: yes\r\n\r\nGET /admin"), exn);
  println(`parse SUCCEEDED, path=[${u.path()}]`);
  req := HttpRequest.new(HttpMethod.GET, u.path());
  req.set_host(u.host().unwrap());
  println(`--- wire bytes std/http would send ---`);
  println(req.to_string());
  println(`--- end ---`);
});
export(main);
```

Observed, verbatim (run through `cat -A`, so `^M` is CR and `$` is end of line):

```
parse SUCCEEDED, path=[/a^M$
X-Injected: yes^M$
^M$
GET /admin]$
--- wire bytes std/http would send ---$
GET /a^M$
X-Injected: yes^M$
^M$
GET /admin HTTP/1.1^M$
Host: example.com^M$
^M$
$
--- end ---$
```

Expected: the `Url.parse` call throws `UrlError.InvalidCharacter(pos : usize(20))`
and no request is ever built.

What the server receives instead is a complete first request
(`GET /a`, with the injected header `X-Injected: yes` and a blank line ending it)
followed by a second, attacker-chosen request line (`GET /admin HTTP/1.1`). That is
textbook HTTP request splitting, and the sink is reached by any program that builds
a fetch URL out of caller-supplied text:

```rust
{ fetch } :: import("std/http");
resp := io.await(fetch(`https://api.example.com/items/${user_supplied}`, io), e);
```

**Also reachable from a remote server.** `_resolve_location`
(`std/http/client.yo:217-237`) builds the next hop's URL from the response's
`Location` header and re-parses it at `std/http/client.yo:112`, and
`parse_response` splits the response on `\r\n` only (`std/http/http.yo:232`), so a
bare `\n` inside a header value survives into the value:

```rust
open(import("std/string"));
{ parse_response } :: import("std/http/http");
{ println } :: import("std/fmt");

main :: (fn(io : Io) -> unit)({
  raw := `HTTP/1.1 302 Found\r\nLocation: /a\nX-Injected: yes\r\nContent-Length: 0\r\n\r\n`;
  match(
    parse_response(raw),
    .Ok(resp) =>
      match(
        resp.get_header(`Location`),
        .Some(v) => println(`Location value survived as [${v}] (len ${v.len()})`),
        .None => println(`no Location header`)
      ),
    .Err(e) => println(`parse failed: ${e}`)
  );
});
export(main);
```

Observed (`cat -A`):

```
Location value survived as [/a$
X-Injected: yes] (len 18)$
```

A redirecting server can therefore choose bytes that land in the *next* request
line, unauthenticated.

The host face of the same gap is currently inert: a CRLF inside the authority does
reach `req.set_host(host)` (`std/http/client.yo:154`) and would inject a header,
but the DNS lookup for that host fails before the socket is written, so the
path/query face above is the live sink.

## Root cause

`Url.parse` (`std/url/index.yo:100-382`) scans the input five times — scheme,
authority (userinfo / host / port), path, query, fragment — and every scan looks
only for its own delimiter, copying all other bytes through verbatim:

| section | scan | validation |
| --- | --- | --- |
| scheme | `std/url/index.yo:128-142` | first byte must be ALPHA (`:119-125`); the per-byte guard at `:136` is separately broken — see `url-scheme-character-guard-is-tautological-so-any-byte-passes.md` |
| authority | `:177-285` | stops at `/`, `?`, `#`; splits on `@`, `[`/`]`, `:`. Port digits are checked by `_parse_port` (`:54-82`). Host bytes: none |
| path | `:294-320` | stops at `?` or `#`. Otherwise none |
| query | `:322-349` | stops at `#`. Otherwise none |
| fragment | `:351-364` | runs to end of input. None |

`grep -n "InvalidCharacter\|is_valid\|invalid" std/url/index.yo` returns exactly two
lines — the declaration at `:11` and the `ToString` arm at `:24` — i.e. there is no
validation site anywhere in the module. The parser's only rejections are
`EmptyInput` (`:103`), `MissingScheme` (`:114`, `:123`, `:138`, `:145`),
`InvalidPort` (`:57`, `:70`, `:76`) and `Other` (`:369`).

The downstream sink has no guard either: `HttpRequest.to_string`
(`std/http/http.yo:114-129`) builds the request line by interpolation —

```rust
result := `${self.method.to_string()} ${self.path} HTTP/1.1\r\n`;
```

— and `self.path` is `req_path` from `std/http/client.yo:138`/`:148`, which is
`url.path()` with `?${url.query()}` appended. Nothing between `Url.parse` and
`write_string` (`std/http/client.yo:172`, `:179`, `:193`) inspects those bytes.

Nobody noticed because coverage stops one variant short: the module's only error
test, `tests/url/url.test.yo:347-354` ("Url UrlError to_string"), asserts
`to_string` for `EmptyInput`, `MissingScheme` and `InvalidPort` and skips
`InvalidCharacter` and `Other`. There is no negative parse test in the file at all.

## Fix

Validate characters in `Url.parse` and construct the variant that already exists.
One linear pre-scan over the input is enough and is the simplest correct shape —
it runs before the scheme scan, so the reported `pos` is a byte offset into the
caller's string:

```rust
/// True for every byte RFC 3986 §2 permits in a URI: unreserved
/// (ALPHA / DIGIT / "-" / "." / "_" / "~"), gen-delims (":" "/" "?" "#"
/// "[" "]" "@"), sub-delims ("!" "$" "&" "'" "(" ")" "*" "+" "," ";" "=")
/// and "%", which introduces a pct-encoded triplet.
_is_uri_byte :: (fn(b : u8) -> bool)( ... );
```

then, at the top of `parse` (after the `EmptyInput` check at `std/url/index.yo:103`):

```rust
vi := usize(0);
while(runtime(vi < src_len), {
  b := s.byte_at(vi);
  cond(
    _is_uri_byte(b) => (),
    true => {
      exn.throw(dyn(UrlError.InvalidCharacter(pos : vi)));
    }
  );
  vi = (vi + usize(1));
});
```

matching the existing throw idiom at `std/url/index.yo:369`. `std/encoding/percent.yo:31`
already has an `_is_unreserved` predicate but it is module-private (leading
underscore, absent from that file's `export` at `:123`) and covers only the
unreserved set, so `std/url` needs its own — do **not** widen `percent.yo`'s
private helper for this.

Percent-triplet well-formedness (`%` followed by two HEXDIG) is a second,
independent check. Either fold it into the same scan (a `%` at `n` requires
`_hex_val`-able bytes at `n+1`/`n+2`) or leave it out of this fix and say so in the
module doc; the request-splitting hazard is closed by the byte-set check alone,
because `%` cannot become CR or LF without a decode step, and `Url.parse` never
decodes.

### The design choice: raw bytes ≥ 0x80

Strict RFC 3986 is ASCII-only, so a URL containing raw UTF-8 (`http://ex.com/héllo`)
must be rejected. Three options:

1. **Strict RFC 3986 — reject every byte outside the legal set, including ≥ 0x80.**
   Matches the module's own header claim, makes the reported `pos` meaningful, and
   is one predicate. **Recommended.**
2. WHATWG-URL leniency — percent-encode illegal bytes instead of rejecting them.
   That is a much larger change (a different specification, and it would leave
   `InvalidCharacter` dead again), and the module does not claim the WHATWG
   contract.
3. Reject only controls and space, let ≥ 0x80 through. Cheaper, but it publishes a
   parser that accepts input the module's own doc line calls invalid, and the
   boundary would need documenting anyway.

Take (1) and state it on `Url.parse`'s doc comment: callers with non-ASCII paths
percent-encode first via `std/encoding/percent`'s `percent_encode`.

### Defense in depth (belongs to the http row, not to this fix)

`HttpRequest.to_string` should refuse to serialize a `path`, header name or header
value containing CR, LF or NUL rather than trusting its caller — the URL fix closes
the `std/http` client path, but `HttpRequest` is public
(`std/http/http.yo:430`) and a server-side or hand-built request has the same
exposure. Related: `parse_response`'s bare-LF tolerance
(`std/http/http.yo:232`) means header values can legally contain `\n` today, which
RFC 9112 §2.2 forbids.

## Regression test

`tests/url/url.test.yo`:

- **`Url parse rejects RFC 3986 forbidden characters`** — must assert that
  `Url.parse` throws for each of: a raw space in the host (`"http://exa mple.com/"`),
  a raw space in the path (`"http://x/a b"`), a control byte (`0x01`) in the path,
  a raw CR (`"http://x/a\rb"`), a raw LF (`"http://x/a\nb"`), a full CRLF
  injection payload (`"http://x/a\r\nX: y\r\n\r\nGET /admin"`), a `"` / `<` / `>` /
  `\` / `` ` `` / `{` / `|` / `}` byte, and a raw UTF-8 byte
  (`"http://x/h\xc3\xa9llo"`). Each case must assert the thrown value is
  `UrlError.InvalidCharacter` with the **exact** `pos`, not merely that something
  threw — the parser already has four other rejections that would satisfy a
  "did it throw" assertion.
- **`Url parse still accepts every legal URI byte`** — the over-rejection canary
  (mandatory here, per the "Guards that skip emission" rule): sub-delims in a query
  (`"http://x/p?a=1&b=2;c=3!"`), `@` and `:` in userinfo
  (`"http://u:p@x:8080/"`), `~`/`-`/`.`/`_` in a path, an IPv6 literal
  (`"http://[::1]:80/"`), a `%20` triplet, `#` in a fragment, and every URL already
  asserted elsewhere in the file must still parse. Verify this test passes BEFORE
  the fix, so it is a real baseline.
- Extend **`Url UrlError to_string`** (`tests/url/url.test.yo:347`) to all five
  variants — it currently covers three.

Both new tests must be verified RED/GREEN in the stated direction before the fix
lands. After it, run `yo test ./tests/url/url.test.yo --parallel 1`, then
`yo test ./tests/http --parallel 1` (std/url is imported by std/http/client.yo:24),
then the fast suite once: `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`.

## Breaking change

Yes — and it must be called out in the release notes. `Url.parse` currently accepts
strings it will reject afterwards. Concretely:

- URLs with raw non-ASCII bytes (option 1 above) stop parsing; callers
  percent-encode instead.
- URLs with raw spaces stop parsing. This is the change most likely to surface in
  existing code, because a space is the byte people forget to encode.
- Anything in-tree that fetches an unencoded URL breaks loudly rather than silently
  — which is the point.

Deleting `UrlError.InvalidCharacter` instead of wiring it would be breaking too and
would leave the request-splitting sink open, so it is not an option here. If the API
freeze cannot absorb the validation, delete the variant now (free pre-freeze) and
re-add it additively with the validation later — but do **not** freeze it
un-constructed while the sink exists.
