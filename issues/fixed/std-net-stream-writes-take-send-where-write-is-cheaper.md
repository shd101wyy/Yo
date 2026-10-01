# std/net stream writes take `send(2)` where `write(2)` is cheaper

**Severity:** S3 — performance: a std `TcpStream` round trip on macOS pays ~130 ns for `send(2)` over `write(2)`, part of the std-vs-libuv gap

**Status: FIXED** (stage 1 #1019, stage 2 #1074). Filed 2026-09-29 from the
macOS async runtime pass. The measurements are **measured** (macOS 26.6, M4).

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

1. **Done (#1019):** `__yo_async_stream_write_start(fd, buf, len)` on
   every backend. It is `write(2)` on macOS (inline, a would-block write
   parks as a WRITE), `send(MSG_NOSIGNAL)` on Linux (no `SO_NOSIGPIPE`
   there), and the ordinary send on Windows and wasm. `SO_NOSIGPIPE` is in
   `std/sys/socket`. Tests: `tests/sys/tcp.test.yo` (a 4 MiB write that
   parks, and a closed peer that returns an error instead of `SIGPIPE`), plus
   pins in `tests/internal/uring_runtime.test.yo`.
2. **Done (#1074), once `SEED_VERSION` carried stage 1 (v0.2.47)** (the compiler imports
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

## Stage 2 as landed (#1074)

- `stream_write` in `std/sys/tcp` and `std/sys/unix`. Every `TcpStream`/`UnixStream` write goes through it.
- `std/sys/sockinfo.own_stream_socket` sets `SO_NOSIGPIPE` on macOS (a no-op elsewhere). It runs at every site that makes a stream: `TcpStream.connect`, `TcpListener.accept`, `TcpListener.incoming`, `UnixStream.connect` and `UnixListener.accept`.
- If setting it fails, the fd is closed and the connect or accept fails with that errno, as libuv's `uv__stream_open` does. `socketpair` has no `std/net` caller, so it needs no site.

**Tests.** A closed-peer write from the connecting end, in both `tests/net/tcp.test.yo` and `tests/net/unix.test.yo`; the existing tests covered the accepted end.

**A/B on the connect site (measured):** with its `own_stream_socket` removed, the TCP test dies with exit code 13, which is `SIGPIPE`. With it, the test passes.

**Measured** on 2026-10-01: `scripts/bench/async-vs-libuv/bench.yo` against `bench_uv.c`, 7 alternating rounds, medians of rounds 2–7, µs per round trip, v0.2.47 seed. The "before" column is develop's std.

| Row | before | after | libuv |
| --- | ---: | ---: | ---: |
| `multi` (8 connections) | 3.70 | 3.54 | 3.19 |
| `pingpong` (1 connection) | 15.24 | 14.47 | 13.79 |

That is −4.3% and −5.1%. The remaining gap to libuv is the per-operation `io.async` wrappers (`issues/std-net-per-op-io-async-wrappers-cost-a-microsecond-a-round-trip.md`; await-site fusion, #1073).
