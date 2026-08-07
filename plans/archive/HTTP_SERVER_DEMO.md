# HTTP Server Demo — `http_server_demo_yo`

## Goal

Create a simple HTTP server demo project in Yo that showcases:

- **Algebraic effects** (`Io`, `Exception`) for async I/O and error handling
- **Async/await** with Futures for concurrent connections
- **Build system** with dependencies (reusable library pattern)
- **String processing** and HTTP protocol handling

## Architecture

```
http_server_demo_yo/
├── build.yo              # Build config
├── src/
│   └── main.yo           # HTTP server with routing
└── README.md
```

The server will be a single-file demo (~200-300 lines) that:

1. Binds to a port (default 8080)
2. Accepts TCP connections in a loop
3. Parses incoming HTTP/1.1 requests
4. Routes to handlers and sends responses
5. Demonstrates error handling via `Exception` effect

## Available Standard Library APIs

### TCP Networking (`std/net/tcp`)

```rust
TcpListener.bind(addr, using(io, exn)) → Future(TcpListener, Io, Exception)
TcpListener.accept(using(io, exn))     → Future(TcpStream, Io, Exception)
TcpStream.connect(addr, using(io, exn))→ Future(TcpStream, Io, Exception)
TcpStream.read(buf, len, using(io))    → Future(i32, Io)          // returns bytes read
TcpStream.read_bytes(n, using(io,exn)) → Future(ArrayList(u8), Io, Exception)
TcpStream.write_str(s, using(io))      → Future(i32, Io)          // str literal
TcpStream.write_string(s, using(io))   → Future(i32, Io)          // String type
TcpStream.close(using(io))             → Future(unit, Io)
TcpStream.shutdown(how, using(io))     → Future(unit, Io)
```

### HTTP Types (`std/http/http`)

```rust
HttpMethod :: enum(GET, POST, PUT, DELETE, HEAD, PATCH)
HttpHeader :: object(name: String, value: String)
HttpRequest :: object(method: HttpMethod, path: String, headers: ArrayList(HttpHeader), body: String)
HttpResponse :: object(status_code: i32, status_text: String, headers: ArrayList(HttpHeader), body: String)
parse_response(raw: String) → Result(HttpResponse, String)  // client-side parser
http_status_text(code: i32) → String
```

**Note:** `parse_response` exists but `parse_request` does not — we need to implement request parsing.

### Error Handling (`std/error`)

```rust
Exception :: module(throw : (fn(err: AnyError) -> unit))
// Usage:
given(exn) := Exception(throw : ((err) -> { escape (); }));
```

### String (`std/string`)

```rust
String.from(s), String.len(), String.is_empty()
String.contains(sub), String.starts_with(prefix), String.ends_with(suffix)
String.index_of(sub) → Option(usize)
String.split(sep) → ArrayList(String)
String.substring(start, len) → String
String.trim(), String.trim_start(), String.trim_end()
String.to_lowercase(), String.to_uppercase()
String.concat(other) → String
String.parse_i32() → Option(i32)
```

## Implementation Plan

### Phase 1: Project Setup ✅

- [x] `yo init http_server_demo_yo` to scaffold project
- [x] Configure `build.yo` (no external deps needed — pure std library)
- [x] Verify it compiles with `./yo-cli build`

### Phase 2: Minimal Echo Server ✅

- [x] Write a minimal TCP server that accepts a connection, reads bytes, and echoes them back
- [x] Verify the async/await pattern works: `TcpListener.bind` → `accept` → `read` → `write` → `close`
- [x] Test with `curl` or `nc`

### Phase 3: HTTP Request Parsing ✅

- [x] Implement `parse_request(raw: String) → Result(HttpRequest, String)` in `main.yo`
  - Parse request line: `GET /path HTTP/1.1\r\n`
  - Parse headers: `Key: Value\r\n` until `\r\n\r\n`
  - Extract body (if Content-Length present)
- [x] Test parsing with known request strings

### Phase 4: HTTP Response Building ✅

- [x] Use existing `HttpResponse` type or build response strings manually
- [x] Helper to serialize response: status line + headers + body
- [x] Support `Content-Type`, `Content-Length`, `Connection: close` headers

### Phase 5: Router + Handlers ✅

- [x] Simple route matching on `request.path`:
  - `GET /` → Welcome page (HTML)
  - `GET /hello` → "Hello, World!" plain text
  - `GET /json` → JSON response `{"message": "Hello from Yo!"}`
  - `GET /echo` → Echo back request headers as HTML
  - `*` → 404 Not Found
- [x] Print request log to stdout: method, path, status code

### Phase 6: Polish & Documentation ✅

- [x] Clean error handling (don't crash on malformed requests)
- [x] Graceful connection close
- [x] `README.md` with usage instructions, curl examples, code walkthrough
- [ ] Update Yo README's example projects table

## Example Code Skeleton

```rust
{ TcpListener, TcpStream } :: import "std/net/tcp";
{ SocketAddr, IpAddr } :: import "std/net/addr";
{ Error, AnyError, Exception } :: import "std/error";
{ ArrayList } :: import "std/collections/array_list";
open import "std/string";
open import "std/fmt";
{ GlobalAllocator } :: import "std/allocator";
{ malloc, free } :: GlobalAllocator;

PORT :: u16(8080);
BUF_SIZE :: usize(4096);

main :: (fn(using(io : Io)) -> unit)({
  given(exn) := Exception(throw : ((err) -> {
    println(`Server error: ${err.message()}`);
    escape ();
  }));

  addr := SocketAddr.new(IpAddr.any_v4(), PORT);
  listener := io.await(TcpListener.bind(addr));
  println(`Listening on http://0.0.0.0:${PORT}`);

  // Accept loop
  while true, {
    stream := io.await(listener.accept());
    handle_connection(stream, using(io, exn));
  };
});

handle_connection :: (fn(stream: TcpStream, using(io: Io), using(exn: Exception)) -> unit)({
  // Read request
  buf := *(u8)(malloc(BUF_SIZE).unwrap());
  n := io.await(stream.read(buf, BUF_SIZE));
  // ... parse request, route, build response, write back ...
  free(.Some(*(void)(buf)));
  io.await(stream.close());
});

export main;
```

## Testing Strategy

1. Build: `cd Yo && ./yo-cli build --build-file ../http_server_demo_yo/build.yo`
2. Run: `./http_server_demo_yo/yo-out/bin/http_server_demo_yo`
3. Test with curl:
   ```bash
   curl http://localhost:8080/
   curl http://localhost:8080/hello
   curl http://localhost:8080/json
   curl -v http://localhost:8080/nonexistent  # 404
   ```

## Notes

- The server handles one connection at a time (sequential accept loop). A concurrent version using `io.spawn` would be a nice follow-up.
- No TLS support — plain HTTP only.
- The `parse_request` function we write here could later be contributed back to `std/http/http.yo`.
- devenv shell is NOT needed for this project (no system C libraries like raylib).
