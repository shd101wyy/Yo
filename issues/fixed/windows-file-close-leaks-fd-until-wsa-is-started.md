# Windows: `__yo_file_close` leaks the CRT fd in any program that never started Winsock

**Status: FIXED (2026-09-12).** Both close paths (`__yo_file_close`, the
sync `File.close_sync`, and `__yo_async_close_start`) used a
"closesocket-first" probe to decide whether an fd was a socket:

```c
SOCKET s = (SOCKET)(uintptr_t)(uint32_t)fd;
int cs = closesocket(s);
if (cs != 0) {
  DWORD wsa_err = WSAGetLastError();
  if (wsa_err == WSAENOTSOCK) {
    _close(fd);
  }
}
```

Two failure modes, one of them reproduced:

1. **WSA never started → every close leaks.** `closesocket` requires a prior
   `WSAStartup`. Only `__yo_io_init` (the async runtime) and `__yo_wsa_init`
   (sync socket helpers) call it — a program that uses neither (sync file
   I/O only) gets `WSANOTINITIALISED` (10093) from `closesocket`, which is
   NOT `WSAENOTSOCK`, so the `_close(fd)` fallback never runs. Every
   open/close round leaks one CRT fd until the UCRT fd table (default 8192)
   fills and every further open fails `EMFILE`. Reproduced on
   Windows 10.0.26200: 9000 open/close rounds, 812 failures, first
   `errno=24` (EMFILE) at round 8188.
2. **Numeric collision can close the WRONG object.** A SOCKET HANDLE VALUE
   travels as an `i32` "fd" through this runtime, and CRT fds are small
   integers — the spaces can collide (CRT fd 420 vs socket handle
   0x1A4). `closesocket(file_fd)` with a colliding value would close the
   socket silently and skip `_close`, leaking the file handle too. Not
   reproduced (needs a specific allocation pattern); the probe order made
   it possible by construction.

Found 2026-09-12 by the Windows async-I/O runtime audit (PR branch
`audit/windows-async-io`). **Severity:** HIGH for long-running sync
programs — a file-processing loop exhausts the fd table after ~8192
open/close rounds and every subsequent open fails.

## Why the test suite never saw it

Every test binary drives an async harness, whose event loop runs
`__yo_io_init` → `WSAStartup` before any test body. The leak only
manifests in standalone SYNC programs — exactly the shape `File` +
`Dispose` (`std/fs/file.yo`) invites. The standalone reproducer therefore
lives here rather than in `tests/`:

```rust
// tmp/close_leak.yo — sync-only program: no async main, no socket call.
pragma(Pragma.AllowUnsafe);
{ open_sync, close_sync } :: import("std/sys/file");
{ O_WRONLY, O_CREAT, O_TRUNC } :: import("std/sys/constants");
{ String } :: import("std/string");
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  path := String.from("./tmp/close_leak_target.txt");
  p := path.to_cstr().ptr().unwrap();
  mode := i32(438); // 0666
  fd0 := open_sync(p, (O_CREAT | (O_WRONLY | O_TRUNC)), mode);
  cond(
    (fd0 < i32(0)) => { println(`initial open failed: ${fd0}`); return(()); },
    true => close_sync(fd0)
  );
  (fails : i32) = i32(0);
  (first_errno : i32) = i32(0);
  (i : i32) = i32(0);
  while(i < i32(9000), i = (i + i32(1)), {
    fd := open_sync(p, O_WRONLY, mode);
    cond(
      (fd < i32(0)) => {
        cond(
          (fails == i32(0)) => { (first_errno = fd); () },
          true => ()
        );
        (fails = (fails + i32(1)));
      },
      true => close_sync(fd)
    );
  });
  cond(
    (fails > i32(0)) => {
      println(`LEAK CONFIRMED: ${fails} of 9000 open rounds failed, first errno=${i32(0) - first_errno}`);
    },
    true => println(`OK: all 9000 open/close rounds succeeded`)
  );
});
export(main);
```

Before the fix: `LEAK CONFIRMED: 812 of 9000 open rounds failed, first
errno=24`. After: `OK: all 9000 open/close rounds succeeded`.

## Fix

`src/codegen/async/runtime_io_windows.yo` now keeps a socket-fd registry
(`__yo_win_sock_fds` + mark/is/unmark, the same shape as the O_APPEND fd
table). Every socket the runtime creates is registered —
`__yo_async_socket_start`, both accept paths (`__yo_win_finish_accept`,
the AF_UNIX fallback `accept()`), and `__yo_sync_socketpair` — and both
close functions consult the registry instead of probing Winsock:

- `__yo_file_close`: registered → `__yo_wsa_init()` + `closesocket` +
  unregister; otherwise plain `_close(fd)`. A file close now touches
  Winsock never.
- `__yo_async_close_start`: same split (`__yo_io_init` at the top already
  guarantees Winsock for the socket arm).

This removes the `WSANOTINITIALISED` leak and the collision hazard by
construction: the runtime KNOWS which fds are sockets instead of asking
the kernel and misreading the answer. The registry's correctness is
exercised by the whole `tests/net` battery (every `TcpStream`/
`UdpSocket` close goes through it — a misroute there fails dozens of
tests); the sync-program leak itself is the standalone repro above.
