# A dropped `TlsStream` leaks its socket and its OpenSSL objects

**Status: FIXED 2026-09-11** (`std/crypto/tls.yo` gained a `Dispose`), with the
caveat in "Residual" below.

## Symptom

`TlsStream` had no `Dispose` impl. Its only teardown was the async
`close(io)`, so there was no way at all — not even an explicit one — to
release a stream from synchronous code, and a stream that went out of scope
leaked:

- the socket descriptor. `TcpStream`'s own `Dispose` cannot help: the socket is
  a private field of the TLS stream, and dropping the TLS stream does not run
  the inner stream's dispose.
- the OpenSSL `SSL` object with both of its BIOs, and the `SSL_CTX`.

This is the same class as
`issues/fixed/a-dropped-watcher-leaves-the-event-loop-calling-freed-memory.md`
— a type owning a raw resource with no `Dispose` — minus the
use-after-free.

## How it was found

`std/http`'s connection pool (`HttpClient`) has to close idle connections from
plain, non-async code: eviction when the pool is full, expiry of an
over-age connection, and the client's own `dispose`. Its `_Transport.close_sync`
delegates to the stream's `Dispose`, and there was nothing to delegate to for
the TLS arm.

## Fix

`impl(TlsStream, Dispose(dispose : ...))` in `std/crypto/tls.yo`: guarded on
the existing `_closed` flag, it frees the OpenSSL objects with
`__yo_tls_free` (which releases both BIOs and the context) and then delegates
to `(TcpStream <: Dispose).dispose(self._tcp)` for the socket.

It deliberately does NOT send a `close_notify`: flushing the write BIO needs
the event loop, and `dispose` runs in plain code. `close(io)` remains the
graceful form and makes `dispose` a no-op afterwards.

## Verification

`issues/repros/dropped-tlsstream-leaks-its-socket.yo` counts open descriptors
synchronously (`dup(0)` returns the lowest free number, so N repeats give
`highest + 1 == open_count + N`). Measured on macOS 2026-09-11:

```
open before=4 connected=8 wrote=8 after=7
```

`after == connected - 1`: the stream's socket goes on `dispose`. The other
three descriptors the connect allocates are libcrypto's own (trust store,
RNG), opened on first use rather than per stream.

## Residual

The IMPLICIT path — letting a `TlsStream` go out of scope — still does not
release it, and that is a separate defect:
`issues/a-ref-value-passed-to-an-async-future-is-never-released.md`.
`TlsStream` is passed as a parameter to the `_flush_wbio` and `_feed_rbio`
futures on every read and write, and each of those leaks a reference, so its
count never reaches zero. The `Dispose` added here is what makes the explicit
teardown possible (and is what `std/http`'s pool uses); it will start firing on
drop as well once that leak is fixed.
