# A relative `Location` whose query carries an absolute URL is mistaken for absolute, then fails to parse

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (a legal redirect turns into a hard
`UrlError.MissingScheme` failure). Reproduced at runtime with v0.2.24.

`std/http/client.yo` decides whether a `Location` header is an absolute URL by
asking whether the string *contains* `://` anywhere:

```rust
// std/http/client.yo:217-221
_resolve_location :: (fn(base_str : String, location : String, exn : Exception) -> String)(
  cond(
    location.contains(`://`) => location,
    ...
```

RFC 3986 §4.1 says a reference is absolute when it *starts* with a valid
`scheme ":"` — not when `://` appears somewhere inside it. The single most
common relative redirect that carries `://` in its query is the SSO/OAuth
return-to hop, `Location: /login?next=https://app.example.com/dash`, and this
check hands it back verbatim as the next URL. `_fetch_once` then calls
`Url.parse` on a string whose first byte is `/`, which throws.

## Reproducer

A listener that answers with one 302 and then a 200 (`server.py`):

```python
import socket, sys
port, loc = 19980, "/login?next=https://app.example.com/dash"
resp = ["HTTP/1.1 302 Found\r\nLocation: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % loc,
        "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndone"]
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(4)
for r in resp:
    c, _ = s.accept()
    print("server saw:", c.recv(4096).decode().split("\r\n")[0]); sys.stdout.flush()
    c.sendall(r.encode()); c.close()
```

The client (`client.yo`):

```rust
{ fetch_with, FetchOptions } :: import("std/http/client");
{ Exception, IoExn } :: import("std/error");
{ println } :: import("std/fmt");
open(import("std/string"));
main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(`fetch threw: ${err.to_string()}`);
        unwind(());
      }
    )
  );
  resp := io.await(fetch_with(`http://127.0.0.1:19980/start`, FetchOptions.new(), io), IoExn(io : io, exn : exn));
  println(`status ${resp.status_code}`);
});
export(main);
```

```
$ python3 server.py & yo compile client.yo --optimize 2 -o client.out && ./client.out
server saw: GET /start HTTP/1.1
fetch threw: URL error: missing scheme
```

Expected: the second hop is requested and the fetch returns 200 —

```
server saw: GET /start HTTP/1.1
server saw: GET /login?next=https://app.example.com/dash HTTP/1.1
status 200
```

## Root cause

`std/http/client.yo:219` tests ``location.contains(`://`)``. The location
`/login?next=https://app.example.com/dash` contains `://` inside its *query*,
so the branch returns it unchanged as the next request URL. One loop iteration
later `_fetch_follow` (`std/http/client.yo:283`) assigns it to `current`, and
`_fetch_once` parses it at `std/http/client.yo:112`. `Url.parse` requires the
first byte to be a letter (`std/url/index.yo:119-125`) and throws
`UrlError.MissingScheme` for a leading `/`. The exception propagates out of
`fetch`/`fetch_with` and the whole request fails.

The same misclassification fires for any relative reference containing `://`,
e.g. `Location: dash?next=https://app.example.com/x` — that one parses (the
first byte is a letter) but yields the garbage scheme `dash?next=https`
(see `url-parse-accepts-any-byte-in-the-scheme.md`), so `_fetch_once` throws
`HttpError.UnsupportedScheme` instead. Either way a valid redirect fails.

Nothing pins this: `tests/http/http.test.yo:200` ("fetch follows redirects,
resolving relative and absolute-path Locations") only exercises `next` and
`/final`.

This is now on the compiler's own critical path: `src/version_cache.yo:27`
imports `std/http/client` and `_download_file` (`src/version_cache.yo:487`)
follows redirects when downloading release bundles.

## Fix

Replace the whole hand-rolled resolver with RFC 3986 §5.2 reference
resolution on parsed components:

1. Add `_remove_dot_segments(path : String) -> String` (§5.2.4) and
   `Url.join(self, reference)` (§5.2.2 + the §5.2.3 merge) to
   `std/url/index.yo`.
2. Inside `join`, classify the reference by *parsing* it, not by substring
   search: a reference has a scheme only when it starts with
   `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`. The scheme scanner
   already exists at `std/url/index.yo:118-142` — extract it into a
   `_scheme_prefix_len(s) -> Option(usize)` helper (and fix its charset check
   while doing so, see `url-parse-accepts-any-byte-in-the-scheme.md`) so both
   `parse` and `join` use one implementation.
3. Delete `_resolve_location` (`std/http/client.yo:217-237`) and call
   `Url.join` at `std/http/client.yo:283`, keeping `current` as a `Url` across
   hops rather than re-parsing a `String` every iteration.

`join`'s return style must match whatever `Url.parse` ends up with — it is
`(s : String, exn : Exception) -> Url` today, which the D1 style rule assigns
to `Result(T, TypedError)` instead (pure fallible transform). Decide `parse`
first, then give `join` the same shape.

No workaround belongs in `_resolve_location`: tightening the `contains`
test alone still leaves the four sibling defects below.

## Regression test

`tests/http/http.test.yo`, next to the existing redirect test at :200, using
the `_serve_scripted` / `_redirect_to` harness already in that file
(:161-198): a 302 whose `Location` is `/login?next=https://app.example.com/x`
must produce a second request line
`GET /login?next=https://app.example.com/x HTTP/1.1` and a 200, not a thrown
`UrlError`.

`tests/url/url.test.yo` should additionally pin the RFC 3986 §5.4.1 normal and
§5.4.2 abnormal example tables against `Url.join` — the spec ships the test
suite, including `http://a/b/c/d;p?q` + `?y` and the `g:h` / `//g` vectors that
cover the sibling defects.

## Related

Four other defects in the same 21-line function, each with its own doc:
`network-path-redirect-location-resolved-against-the-base-host.md`,
`redirect-resolution-never-removes-dot-segments.md`,
`empty-path-redirect-location-drops-the-base-paths-last-segment.md`,
`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`.
All five are fixed by the one `Url.join` implementation above and should land
as a single PR.
