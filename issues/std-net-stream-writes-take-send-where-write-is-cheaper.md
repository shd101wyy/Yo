# std/net stream writes take `send(2)` where `write(2)` is cheaper

**Severity:** S3 — performance: a std `TcpStream` round trip on macOS pays ~130 ns for `send(2)` over `write(2)`, part of the std-vs-libuv gap

**Status: OPEN, stage 1 of 2 done.** Filed 2026-09-29 from the macOS async
runtime pass. The measurements are **measured** (macOS 26.6, M4).

## Symptom

libuv writes its TCP streams with `write(2)`. Yo's std streams go through
`__yo_async_send_start`, which calls `send(2)` with `MSG_NOSIGNAL |
MSG_DONTWAIT`. On TCP loopback, timing only the call in C (medians of 9
runs), `write` costs 1.40 µs and `send` costs 1.46–1.51 µs, whatever the
flags. On the std 8-connection ping-pong, patching the emitted C to use
`write` on `SO_NOSIGPIPE` sockets took the median from 3,582 to 3,450 ns a
round trip (7 runs each), against libuv's 3,180.

## Why std cannot simply write

`send`'s flags are its safety contract: `MSG_NOSIGNAL` (no `SIGPIPE` on a
closed peer) and `MSG_DONTWAIT` (never block the loop). `write` takes no
flags. It is equivalent only on a socket that is already non-blocking and,
on Apple, has `SO_NOSIGPIPE` set. The runtime cannot know that about an
arbitrary fd without tracking state that a raw FFI `close`/`fcntl`
silently invalidates. std can: it creates its stream sockets, so it can
set both properties and then promise them, which is libuv's design
(`uv__stream_open`).

## The fix, in two stages (the seed gates the second)

1. **Done, this PR:** `__yo_async_stream_write_start(fd, buf, len)` on
   every backend. It is `write(2)` on macOS (inline, a would-block write
   parks as a WRITE), `send(MSG_NOSIGNAL)` on Linux (no `SO_NOSIGPIPE`
   there), and the ordinary send on Windows and wasm. `SO_NOSIGPIPE` is in
   `std/sys/socket`. Tests: `tests/sys/tcp.test.yo` (a 4 MiB write that
   parks, and a closed peer that returns an error instead of `SIGPIPE`), plus
   pins in `tests/internal/uring_runtime.test.yo`.
2. **Next, once `SEED_VERSION` carries stage 1** (the compiler imports
   `std/http` → `std/net`, and std cannot call a runtime symbol the seed does
   not emit; see the c-codegen instructions, "A codegen fix does not license
   the source form"):
   - declare `__yo_async_stream_write_start` in `std/sys/externs.yo`, with a
     `stream_write` wrapper in `std/sys/tcp.yo`;
   - on Apple, set `SO_NOSIGPIPE` on every stream socket std creates:
     `TcpStream.connect`, `TcpListener.accept`, the `UnixStream`
     equivalents and `socketpair`;
   - route `TcpStream`/`UnixStream` `write`, `write_str`, `write_string` and
     `write_bytes` through `stream_write`;
   - re-measure the std rows, and move this doc to `fixed/`.
