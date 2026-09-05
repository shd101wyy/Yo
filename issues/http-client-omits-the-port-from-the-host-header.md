# `fetch` sends `Host: <host>` without the port, so any server on a non-default port sees the wrong `Host`

## Status

**OPEN** — found 2026-09-04 while verifying the redirect-resolution defects
during the std-API audit re-measurement of the `url` row (every request line
the probe listener captured carried a portless `Host`). **Severity:
wrong-value** (name-based virtual hosts route to the wrong site; strict
servers answer 400). Reproduced at runtime with v0.2.24.

## Reproducer

A listener on 19981 that prints the request it receives (`host.py`):

```python
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 19981)); s.listen(1)
c, _ = s.accept()
sys.stdout.write(c.recv(4096).decode()); sys.stdout.flush()
c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"); c.close()
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
  resp := io.await(fetch_with(`http://127.0.0.1:19981/x`, FetchOptions.new(), io), IoExn(io : io, exn : exn));
  println(`status ${resp.status_code}`);
});
export(main);
```

```
$ python3 host.py & yo compile client.yo --optimize 2 -o client.out && ./client.out
GET /x HTTP/1.1
Host: 127.0.0.1
Connection: close

status 200
```

Expected: `Host: 127.0.0.1:19981`. RFC 9110 §7.2 defines the field as
`Host = uri-host [ ":" port ]` and requires a client whose target URI has an
authority to send a value "identical to that authority component, excluding
any userinfo subcomponent and its `@` delimiter" — so the port belongs in it
whenever the URL carries one. curl, browsers and reqwest all send it.

## Root cause

`std/http/client.yo:154`:

```rust
req := HttpRequest.new(opts.method, req_path);
req.set_host(host);
```

`host` is `url.host()` alone (`std/http/client.yo:126-133`). The port is
parsed and in scope two lines earlier — `port := match(url.port(), .Some(p) =>
p, .None => default_port)` (`std/http/client.yo:136`) — and is used for the
TCP connect, but never reaches the header. `set_host`
(`std/http/http.yo:79-81`) is a plain "push a `Host` header with this value"
helper and is not at fault.

`std/url` even offers the right accessor: `host_port()`
(`std/url/index.yo:406-418`) returns `host:port` when the URL carries an
explicit port and the bare host otherwise.

Consequences: a server doing name-based virtual hosting on a non-default port
picks the wrong vhost (or its default one); a server that validates `Host`
against the connection port answers `400 Bad Request`; and any HTTP/1.1 origin
server is entitled to reject the request, since the field is mandatory and
must identify the target. It is invisible against a default-port service,
which is why the compiler's own bundle downloads over 443
(`src/version_cache.yo:487`) have not tripped over it — every test-server,
proxy and local-service target does.

## Fix

Send the authority, not the host:

```rust
req.set_host(match(url.port(), .Some(p) => `${host}:${p}`, .None => host.clone()));
```

i.e. `url.host_port()` (`std/url/index.yo:406`) with a `.None` fallback to
the host `_fetch_once` already extracted. Note this deliberately echoes the
URL's *parsed* authority rather than the resolved `port` variable at
`std/http/client.yo:136`: `port` has the scheme default folded in, and
`http://h/` must send `Host: h`, not `Host: h:80`.

Design point: what to do when the URL spells the default port out
(`http://h:80/`). RFC 9110 §7.2 asks for the authority as written, so the
one-line fix above (send `h:80`) is conformant and is the recommendation.
Browsers send `Host: h` there because they normalize the *URL* first — RFC
3986 §6.2.3 drops a scheme-default port. If that normalization is wanted, put
it in `Url.parse` (or a `normalize()`), where it also fixes `origin()`
emitting `https://x:443`, and leave this call site as the plain authority
echo. Do not special-case the port inside the client.

## Regression test

`tests/http/http.test.yo`, with the `_serve_scripted` harness at :161-198
(which already records every request it receives): bind on a non-default port,
`fetch_with` it, and assert the captured request contains
`Host: 127.0.0.1:<port>`. Add a companion assertion that a URL with no port
(`http://127.0.0.1/…`) still yields a bare `Host: 127.0.0.1` — that is the
case the naive `${host}:${port}` fix would break, since `port` there is the
scheme default.

The existing `HttpRequest` tests at :24, :32 and :50 call `set_host` directly
and are unaffected.

## Breaking change

No — the emitted header becomes the RFC-conformant one. Anything recording
raw request bytes as a golden must be re-recorded.
