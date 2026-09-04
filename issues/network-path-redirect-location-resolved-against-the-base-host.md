# A network-path `Location` (`//host/path`) is sent to the base host with the new authority glued on as a path

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (the request silently goes to the wrong
server, and the response is accepted as if it came from the right one).
Reproduced at runtime with v0.2.24.

## Reproducer

A listener that answers with one 302 pointing at a *different* authority, then
a 200 (`server.py`):

```python
import socket, sys
port, loc = 19980, "//127.0.0.1:19999/cdn"
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
server saw: GET //127.0.0.1:19999/cdn HTTP/1.1
status 200
```

Both request lines arrive at the **base** server on port 19980. Nothing is
sent to 127.0.0.1:19999.

Expected (RFC 3986 §4.2 + §5.2.2): the second hop connects to
`127.0.0.1:19999` and requests `GET /cdn HTTP/1.1`, inheriting only the base's
scheme.

## Root cause

`_resolve_location` (`std/http/client.yo:217-237`) has exactly three branches,
and the abs-path one swallows network-path references:

```rust
// std/http/client.yo:224
location.starts_with(`/`) => `${origin}${location}`,
```

`//127.0.0.1:19999/cdn` starts with `/`, so it is concatenated onto the base
origin, producing `http://127.0.0.1:19980//127.0.0.1:19999/cdn`. `Url.parse`
reads that back as host `127.0.0.1:19980` with path `//127.0.0.1:19999/cdn`
(the authority scan stops at the first `/` after `//`,
`std/url/index.yo:178-191`), and `_fetch_once` puts that path on the wire
verbatim (`std/http/client.yo:138-151`).

RFC 3986 §4.2 defines `//authority/path` as a *network-path reference*, and
§5.2.2 handles it as its own case: `T.authority = R.authority`, `T.path =
remove_dot_segments(R.path)`, and only the scheme is inherited from the base.
There is no such case here.

Protocol-relative redirects are ordinary in CDN and scheme-upgrade setups, and
the failure is silent: the base server answers 404 (or, worse, 200 for a
catch-all route) and the caller sees a normal response from the wrong origin.
No test covers it — `tests/http/http.test.yo:200` pins only `next` and
`/final`.

`src/version_cache.yo:27` now downloads release bundles through this same
resolver (`_download_file`, `src/version_cache.yo:487`), so the compiler's own
update path is exposed to it.

## Fix

Implement RFC 3986 §5.2.2 in `std/url/index.yo` as `Url.join(self, reference)`
and delete `_resolve_location`. The branch order that matters here is the
spec's own:

1. reference has a scheme → take everything from the reference;
2. **reference has an authority** (i.e. begins `//`) → `T.scheme = Base.scheme`,
   `T.authority = R.authority`, `T.path = remove_dot_segments(R.path)`;
3. reference path empty → keep `Base.path` (and `Base.query` when the
   reference has none);
4. reference path starts with `/` → `T.path = remove_dot_segments(R.path)`;
5. otherwise → `T.path = remove_dot_segments(merge(Base, R))` (§5.2.3).

Case 2 must be tested **before** the `starts_with("/")` case, exactly as
written above, or `//` keeps falling into case 4. `Url.parse` already parses
an authority-only reference correctly once it is given a scheme, so `join` is
best written over parsed components rather than strings.

## Regression test

`tests/http/http.test.yo`, with the `_serve_scripted` harness at :161-198: bind
**two** listeners, script the first to answer `302` with
`Location: //127.0.0.1:<port2>/cdn`, and assert the second listener saw
`GET /cdn HTTP/1.1` while the first saw only the initial request.

`tests/url/url.test.yo`: the RFC 3986 §5.4.1 vector `//g` against base
`http://a/b/c/d;p?q` must join to `http://g`.

## Related

Four other defects in the same function, each with its own doc:
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`,
`redirect-resolution-never-removes-dot-segments.md`,
`empty-path-redirect-location-drops-the-base-paths-last-segment.md`,
`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`.
One `Url.join` implementation fixes all five; land them as one PR.
