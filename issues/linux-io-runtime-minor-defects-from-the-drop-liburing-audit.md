# Linux async runtime: smaller defects found by the DROP_LIBURING audit

**Status: OPEN.** Filed 2026-09-27. Each item is marked with how it was
established. None of them is a crash on the default (io_uring) path.

1. **`__yo_uring_enter`'s EINTR retries are dead code** (read). It returns
   `(int)syscall(...)`, which is `-1` with `errno` set. liburing returned `-errno`.
   So `while (ret == -EINTR)` never matches, and every enter failure surfaces as
   `-1`, which reads as `-EPERM`. Fix: `long r = syscall(...); return r < 0 ? -errno : (int)r;`.
2. **The DEGRADED rung busy-spins while a `spawn_blocking` is in flight** (read).
   `__yo_io_wait` returns 0 without waiting on the eventfd it created. Fix: poll the
   eventfd, as the uninitialised branch does.
3. **`__yo_io_close_hook` is a process-global** written by whichever thread picks
   epoll (read). That is a data race, and the hook stays set after teardown. Make
   it `_Thread_local`, or test `__yo_backend` at the call site.
4. **The fallback log line is per thread**, not "exactly one line" (read). An
   unrecognised `YO_IO_BACKEND` value (a typo) silently means `auto`. Plan G4's
   Docker-profile hint for ENOSYS is missing.
5. **AF_UNIX `connect` → EAGAIN** (backlog full) is parked for EPOLLOUT and then
   reported as success on `SO_ERROR == 0`, without retrying `connect` (read).
6. **The G3 counters count only `io_uring_enter` / `epoll_wait`** (read). Epoll's
   own `read`/`send`/`accept` syscalls are not counted, so "epoll 0 enters/op" is
   an artifact of what is counted. `zero_timeout_enters` also counts plain submits
   (`if (min_complete == 0)`). The budget and bench scripts write fixed `/tmp/...`
   paths that collide across concurrent runs.
7. **The backend bench is not apples to apples** (read). The "TCP echo" bench is an
   AF_UNIX socketpair that always sends before it receives: inline syscalls on
   epoll against submit+reap on the ring. Timings are whole milliseconds on
   roughly 7 ms runs. The claimed "timers 20x faster on epoll" is more likely the
   ring's timerfd READ being punted to io-wq on that WSL2 kernel (suspected, not
   measured). `io-floors.env` kept its pre-measurement floors although it says it
   only tightens.
8. **Epoll registration lookup is O(n)** per park and per event (read). Never
   benchmarked at thousands of connections.
