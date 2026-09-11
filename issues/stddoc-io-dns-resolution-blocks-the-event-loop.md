# "Async DNS resolution" blocks the whole event loop — `getaddrinfo` runs synchronously on the loop thread

**Found:** 2026-09-11, during the `std/` `///` doc sweep (agent A4, net/http/io group).
**Status:** open. Filed, not fixed — the sweep is documentation-only. The doc
comments in `std/net/dns.yo` were corrected in the sweep to describe what the
code does; the CODE defect below is untouched.

## Behaviour

`io.await(lookup_host(host, io), e)` looks like every other awaited I/O
operation in `std/`, so a reader expects it to park the task and let the event
loop run other tasks while the resolver works. It does not. The resolver runs
to completion on the event-loop thread before the future is even handed back,
so for the duration of the lookup — up to the resolver's own timeout, seconds
if a nameserver is unreachable — NO other task on the loop makes progress:
not an accepted connection, not a timer, not a concurrent request.

## Root cause

`src/codegen/async/runtime_io_common.yo:1094-1115` (POSIX) and
`src/codegen/async/runtime_io_windows.yo:3738-3760` (Windows) are the same
shape:

```c
static __yo_io_future_t* __yo_async_getaddrinfo_start(const uint8_t* node, const uint8_t* service,
                                                     const uint8_t* hints, uint8_t** result) {
  ...
  struct addrinfo* res = NULL;
  int ret = getaddrinfo((const char*)node, (const char*)service, (const struct addrinfo*)hints, &res);
  ...
  atomic_init(&future->state, -1);   // already complete
  return future;
}
```

`getaddrinfo(3)` is a blocking call. It is invoked in `*_start` — the
SUBMISSION half — and the future is returned already resolved (`state = -1`),
so the await completes immediately with a value that was produced by blocking
the caller. There is no `io_uring`/kqueue/IOCP submission and no worker
thread; the `IoFuture` wrapper is doing nothing but carrying the result.

That is why `std/net/dns.yo`'s own header called it "Async DNS resolution": at
the Yo level the signature is indistinguishable from a real async operation.

## Why it matters

Yo's async model is explicitly single-threaded — one event-loop thread runs
every submission and completion (`AGENTS.md`, "Async/await threading model").
That model's whole safety property is that nothing on the loop blocks. An
`HttpServer.serve` loop that resolves a name per request, or any program that
resolves while other tasks are in flight, stalls everything for the resolver's
latency, and the stall is invisible in the source: the call site is spelled
exactly like a non-blocking one.

`getaddrinfo` is the one blocking call in the whole `io` surface that has no
non-blocking kernel counterpart, which is why every other runtime special-cases
it: libuv, tokio and Go all run it on a thread pool
(`uv_getaddrinfo`, `tokio::net::lookup_host` → `spawn_blocking`, Go's netgo/cgo
resolver goroutine).

## Fix sketch (not applied)

Two shapes, in increasing order of work:

1. **Run it on the thread pool that already exists.** `spawn_blocking` is
   deliberately still open (`plans/STD_API_STABILIZATION.md` §4, Concurrency:
   *"`spawn_blocking` is deliberately still open, and this is why…"*), and DNS
   is precisely its motivating case — the resolution belongs in whatever that
   decision produces, with the completion posted back to the loop.
2. **Use an async resolver** (`getaddrinfo_a`, or UDP DNS queries submitted
   through the existing socket machinery). Portable and correct, but it means
   owning a resolver, `/etc/resolv.conf` parsing and search-domain rules.

Until one of those lands, the honest statement is the one now in the module
doc: this is a BLOCKING call wearing an async signature. Prerequisite for
either fix: `plans/STD_API_STABILIZATION.md`'s `spawn_blocking` decision.

Note the wasm runtime is not affected because it has no resolver at all —
`runtime_io_wasm.yo:716` returns `-ENOSYS`.
