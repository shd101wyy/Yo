# A `std/net` stream write to a peer that has closed kills the process with SIGPIPE

**Status: FIXED (2026-09-28).** Found during the macOS async-runtime audit, and
**reproduced** on macOS 26.6 with the seed v0.2.45 and develop at af62bdb28.
The Linux path has the same mechanism (read, not run: no Linux box).

## Symptom

A `TcpStream` (or `UnixStream`) server writes a response to a client that has
already disconnected. The whole process exits with status 141
(128 + `SIGPIPE`), with no error, no unwinding, and buffered stdout lost:

```rust
listener := io.await(TcpListener.bind(SocketAddr.loopback(u16(0)), io), e);
c := io.await(TcpStream.connect(listener.local_addr(), io), e);
s := io.await(listener.accept(io), e);
io.await(c.close(io), e);
io.await(s.write_string(String.from("hello"), io), e);   // ok: RST not back yet
io.await(s.write_string(String.from("hello"), io), e);   // process killed
```

Any std server can be taken down by one client that disconnects mid-response.

## Root cause

`std/net`'s `write`/`write_str`/`write_string`/`write_bytes` called the raw
`std/sys/{tcp,unix}.send` with flags `0`. POSIX `send` on a stream whose peer
has closed raises `SIGPIPE` before it returns `EPIPE`, and the signal's
default action terminates the process. The raw layer documents this ("nothing
in the generated runtime ignores `SIGPIPE`"). The typed layer never opted out.

## Fix

`std/sys/socket.yo` gains `MSG_NOSIGNAL` (`0x80000` on macOS, which has it
since POSIX.1-2008 and in the macOS 14 SDK; `0x4000` on Linux; `0` on Windows,
which has no `SIGPIPE`). Every `std/net` stream send passes it, so the write
fails with `EPIPE` (or `ECONNRESET`) and throws `IoError.BrokenPipe` through
the caller's `IoExn` like any other I/O error. The raw `std/sys` layer is
unchanged: its `flags` still go straight to the syscall, and its doc now names
the constant.

## Tests

`tests/net/tcp.test.yo` "a TcpStream write to a peer that has closed throws
instead of killing the process", and `tests/net/unix.test.yo` "a UnixStream
write to a peer that has closed throws instead of killing the process". Before
the fix both children die of signal 13 (the runner reports `exit code 13`).
After, the write throws and the test passes.
