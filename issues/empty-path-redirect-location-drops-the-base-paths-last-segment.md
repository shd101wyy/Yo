# A query-only or fragment-only `Location` drops the base path's last segment

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (the next hop requests a different
resource than the server named). Reproduced at runtime with v0.2.24.

`Location: ?page=2` and `Location: #frag` are references with an **empty
path**. RFC 3986 §5.2.2 keeps the base path for them:

```
if defined(R.path) and R.path == "" then
   T.path = Base.path;
   if defined(R.query) then T.query = R.query; else T.query = Base.query;
```

`_resolve_location` has no empty-path case, so both fall into the merge branch
and lose the base path's last segment.

## Reproducer

A listener that answers with one 302 whose `Location` is query-only, then a
200 (`server.py`):

```python
import socket, sys
port, loc = 19980, "?page=2"
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
  resp := io.await(fetch_with(`http://127.0.0.1:19980/a/b`, FetchOptions.new(), io), IoExn(io : io, exn : exn));
  println(`status ${resp.status_code}`);
});
export(main);
```

```
$ python3 server.py & yo compile client.yo --optimize 2 -o client.out && ./client.out
server saw: GET /a/b HTTP/1.1
server saw: GET /a/?page=2 HTTP/1.1
status 200
```

Expected: `GET /a/b?page=2 HTTP/1.1`.

The fragment-only form loses the segment too, and the query with it. With
`loc = "#frag"` and the same base:

```
server saw: GET /a/b HTTP/1.1
server saw: GET /a/ HTTP/1.1
```

Expected: `GET /a/b HTTP/1.1` — a fragment is not sent to the server, so the
second hop must re-request the same resource.

## Root cause

`_fetch_follow` only guards against a *fully empty* `Location`
(`std/http/client.yo:273`, `!location.is_empty()`), so `?page=2` and `#frag`
are treated as ordinary relative references. `_resolve_location`'s third
branch (`std/http/client.yo:225-233`) then computes

```rust
base_path := base.path();
dir := match(
  base_path.last_index_of(`/`),
  .Some(i) => base_path.substring(usize(0), i + usize(1)),
  .None => `/`
);
`${origin}${dir}${location}`
```

which is RFC 3986 §5.2.3 `merge()` — correct for a reference with a *non-empty*
relative path, and wrong here: for base path `/a/b`, `dir` is `/a/` and the
result is `http://h/a/?page=2`. The `b` segment is gone.

The empty-path case is one of the five §5.2.2 branches, and it is the only one
that also has to reason about the query (`T.query = Base.query` when the
reference has none). String concatenation cannot express that — the decision
needs the reference's parsed components.

Nothing pins this; `tests/http/http.test.yo:200` covers only `next` and
`/final`. `src/version_cache.yo:27` imports `std/http/client` and
`_download_file` (`src/version_cache.yo:487`) follows redirects, so the
compiler's own bundle download runs through the same code.

## Fix

Implement the §5.2.2 branch table as `Url.join` in `std/url/index.yo` (see
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`),
including the empty-path case verbatim:

- `R.path == ""` → `T.path = Base.path`; `T.query = R.query` when the reference
  has a query, else `Base.query`;
- `T.fragment = R.fragment` unconditionally, in every branch.

Then delete `_resolve_location` (`std/http/client.yo:217-237`) and call
`Url.join` at `std/http/client.yo:283`. A parsed `Url` distinguishes "no
query" from "empty query" already (`_query : Option(String)`,
`std/url/index.yo:90`), which is exactly what the branch needs; note that
`Url.parse("?x=1")` cannot be used to parse a *reference* today, since parse
demands a scheme — `join` must parse the reference itself, or `parse` must
grow a reference mode.

## Regression test

`tests/url/url.test.yo`: the RFC 3986 §5.4.1 vectors `?y` →
`http://a/b/c/d;p?y` and `#s` → `http://a/b/c/d;p?q#s` against base
`http://a/b/c/d;p?q`. Both are empty-path references and both are currently
resolved wrongly.

`tests/http/http.test.yo`, with the `_serve_scripted` harness at :161-198: a
302 with `Location: ?page=2` from base `/a/b` must produce
`GET /a/b?page=2 HTTP/1.1`, and one with `Location: #frag` must produce
`GET /a/b HTTP/1.1`.

## Related

Four other defects in the same function, each with its own doc:
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`,
`network-path-redirect-location-resolved-against-the-base-host.md`,
`redirect-resolution-never-removes-dot-segments.md`,
`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`.
One `Url.join` implementation fixes all five; land them as one PR.
