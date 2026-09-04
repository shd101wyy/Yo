# Redirect resolution never runs `remove_dot_segments`, so `..` and `.` reach the wire

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (the resolved target depends on how each
server happens to normalize, and a chain of `../` hops can walk above the
document root). Reproduced at runtime with v0.2.24.

## Reproducer

A listener that answers with one 302 carrying a dot-segment `Location`, then a
200 (`server.py`):

```python
import socket, sys
port, loc = 19980, "../x"
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
  resp := io.await(fetch_with(`http://127.0.0.1:19980/a/b/c`, FetchOptions.new(), io), IoExn(io : io, exn : exn));
  println(`status ${resp.status_code}`);
});
export(main);
```

```
$ python3 server.py & yo compile client.yo --optimize 2 -o client.out && ./client.out
server saw: GET /a/b/c HTTP/1.1
server saw: GET /a/b/../x HTTP/1.1
status 200
```

Expected (RFC 3986 §5.2.2 + §5.2.4): the second request line is
`GET /a/x HTTP/1.1`. A dot segment must never appear in a request target —
RFC 9110 §7.1 requires the client to resolve the reference before sending it.

## Root cause

`_resolve_location` (`std/http/client.yo:217-237`) is three string
concatenations, and none of them normalizes the result:

- `std/http/client.yo:219` returns an absolute `Location` verbatim;
- `std/http/client.yo:224` returns `${origin}${location}` for `/abs`;
- `std/http/client.yo:225-233` computes the base path's directory with
  `last_index_of("/")` and returns `${origin}${dir}${location}`.

RFC 3986 §5.2.2 applies `remove_dot_segments` (§5.2.4) to the target path in
**every** branch — the scheme-defined one, the authority-defined one, the
abs-path one, and the merged one. `grep -rn "remove_dot_segments" std/ src/
tests/` finds nothing: the algorithm does not exist anywhere in the tree.
(`std/path.yo:105-140` folds `.`/`..` for *filesystem* paths, but a URL path is
not a `Path` — routing one through `Path.new` would also collapse the
authority and drop a trailing slash, both of which are significant here.)

Consequences beyond the ugly request line: `..` above the root
(`Location: ../../../../etc` from `/a/b`) is left for the server to interpret,
Apache and nginx and a static file handler each answer differently, and a
`Location: .` or `./` hop that RFC 3986 resolves to the current directory is
sent literally. Two servers therefore resolve the same redirect chain to two
different resources.

No test covers it: `tests/http/http.test.yo:200` pins only the `next` and
`/final` cases.

`src/version_cache.yo:27` now imports `std/http/client`, and `_download_file`
(`src/version_cache.yo:487`) follows redirects, so the compiler's own bundle
download runs through this resolver.

## Fix

Add `_remove_dot_segments(path : String) -> String` to `std/url/index.yo` as a
faithful RFC 3986 §5.2.4 implementation, and apply it in every branch of the
new `Url.join` (see
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md` for
the branch table), then delete `_resolve_location`.

Write it over segments rather than the spec's literal buffer loop — split on
`rune(u32(47))` (`u8` does not implement `Pattern`), then:

- `.` segments are dropped;
- `..` segments pop the previous segment, and are dropped (not popped below
  the root) when the output is empty;
- a trailing `.` or `..` leaves a trailing `/`, which the buffer form of the
  algorithm produces and a naive segment join loses — §5.4.2's
  `http://a/b/c/d;p?q` + `..` → `http://a/b/` is the vector that catches it;
- the leading `/` of an absolute path is preserved.

`remove_dot_segments` applies to the path only; the query and fragment are
never touched.

## Regression test

`tests/url/url.test.yo`: pin the RFC 3986 §5.4.1 normal-examples table (19
vectors) and the §5.4.2 abnormal-examples table (16 vectors) against
`Url.join`. Those tables exist precisely to pin this algorithm, and they
include the above-root cases (`/../g` → `http://a/g`) and the trailing-dot
cases (`..` → `http://a/b/`).

`tests/http/http.test.yo`, with the `_serve_scripted` harness at :161-198: a
302 with `Location: ../x` from base `/a/b/c` must produce the request line
`GET /a/x HTTP/1.1`.

## Related

Four other defects in the same function, each with its own doc:
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`,
`network-path-redirect-location-resolved-against-the-base-host.md`,
`empty-path-redirect-location-drops-the-base-paths-last-segment.md`,
`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`.
One `Url.join` implementation fixes all five; land them as one PR.
