# D6 Schannel (#413) hangs the Windows `test` legs for 4 hours — merged on a false green, reverted

**Status: OPEN — #413 REVERTED from develop 2026-09-06.** The Schannel work
itself is not known to be wrong; the Windows test legs never completed, so it
was never actually verified.

**Severity: blocking.** With #413 on `develop`, `test (windows-latest)` and
`test (windows-11-arm)` hang and are cancelled at the 4-hour job timeout, so
develop CI can never go green and every PR burns ~8 Windows CI-hours before
being cancelled.

## The measurements

| develop commit | `test (windows-latest)` |
| --- | --- |
| `70d3c463d` (immediately before #413) | **success, 26 min** (12:21:17 → 12:47:40) |
| `269ad314a` (**the #413 merge**) | started 14:45:36, **never completed** |

#413's own branch, every SHA it ever had:

| SHA | windows-latest | windows-11-arm |
| --- | --- | --- |
| `c3504f911` | **failure** ~9 min | **failure** ~14 min |
| `d13391c80` | **cancelled at 4h00m** | **cancelled at 4h00m** |
| `ad880aa74` | **cancelled at 4h00m** | **cancelled at 4h00m** |
| `c56fcb5af` | **cancelled at 4h00m** | **cancelled at 4h00m** |

The one run that FAILED rather than hung names the shape of the problem:

```
✗ tls_available links and answers in a sync-only program
  Test failed with exit code 22
```

After that assertion was adjusted, the legs stopped failing and started
**hanging** instead — which is worse, because a 4-hour cancellation produces no
downloadable log blob (`BlobNotFound`), so there is nothing to read afterwards.

## Why it was merged anyway — the false green

**Each SHA produces TWO workflow runs**, and the Windows `test` jobs live in the
one that ends `cancelled`:

```
33955677356 c56fcb5af completed/success    <- "Install scripts"
33955677351 c56fcb5af completed/cancelled  <- holds test (windows-latest/arm)
```

`gh pr checks 413` summarised as `{"pass":30,"pending":2}` and then reported
GREEN: a `cancelled` leg is neither `pass` nor `fail` in the bucket vocabulary,
so a bucket histogram that only watches for `fail` calls the PR green the moment
the cancelled legs stop being `pending`. **A cancelled required leg is not a
passing leg**, and any release gate keyed on `gh pr checks` must treat
`cancelled` as a failure — not merely as "not failed".

## Where the hang most likely is

#413 removed `pragma(Pragma.SkipWindows)` from `tests/crypto/tls.test.yo` and
`tests/http/http.test.yo` — a single pragma that had been skipping the WHOLE
HTTP suite on Windows. Those suites therefore ran on Windows for the first time
ever, against a brand-new Schannel backend. Candidates, in order:

1. A TLS handshake that never completes and has no deadline — the Schannel
   pump's `__yo_tls_buf` in/out/plain/scratch loop waiting on a
   `SEC_E_INCOMPLETE_MESSAGE` that never arrives.
2. A loopback HTTP test whose accept/read never returns on Windows.
3. `tls_available()` itself blocking rather than answering, which is what the
   one non-hanging failure (exit 22) was already complaining about.

## How to re-land

The revert restores `SkipWindows` on both suites, so the Schannel C is the only
thing that has to be re-proven. Do NOT re-land by re-removing the pragma and
hoping.

1. **Get a Windows verdict in minutes, not hours.** Add a per-job timeout well
   under 4h (`timeout-minutes: 45` on the Windows `test` legs) so a hang
   produces a downloadable log instead of a blob-less cancellation. This is
   worth doing regardless of D6 — it is what made the failure undiagnosable.
2. Re-land the Schannel backend **with the pragmas still in place**, so the C
   compiles and links on Windows without the suites running.
3. Then remove the pragmas in a SEPARATE PR, with a per-test deadline on every
   network/TLS test, and confirm the Windows legs complete in ~26 min.
4. `zig cc -target x86_64-windows-gnu` compiles AND links the emitted Windows C
   locally in ~40 s — it proves symbol availability, but it cannot catch a
   runtime hang, which is exactly the gap that let this through.

## Gate to add

A release/merge gate must reject `cancelled` required checks. The failure here
was not the Schannel code — it was that a 4-hour hang was indistinguishable
from a pass at the point of decision.

## Step-2 findings (2026-09-06, PR #443 with `timeout-minutes: 75` on the Windows legs)

With the pragmas off and a 75-minute deadline, both Windows legs produced logs.
They say something the four-hour blobs could not:

- **The Schannel handshake is NOT the hang.** `fetch over https returns a real
  response` — a live TLS fetch to a real host — **passes** on both
  `windows-latest` and `windows-11-arm`. It is the last test to complete.
- **The hang is `fetch follows redirects, resolving relative and absolute-path
  Locations`** (`tests/http/http.test.yo`), a pure-loopback test: a spawned
  server task accepts THREE sequential connections on one listener, answering
  302 / 302 / 200, while the client reconnects after each response closes.
- **Plain loopback TCP passes on Windows** — `TCP connect to listener and
  accept`, the echo test and `read_to_end` all completed in the same run — but
  every one of those accepts exactly ONCE per listener.

So the suspect is the Windows async backend's handling of a *repeated* accept
(re-arming `AcceptEx` on a listener after a previous completion) or of a client
reconnect after the server closed the previous connection — the first shapes
the Windows legs have ever run, since the http suites were always skipped there.

PR #443 now carries two cross-platform bisecting probes in
`tests/net/tcp.test.yo` (`… (D6 Windows re-arm probe)` / `… (D6 Windows
probe)`): three sequential accept+exchange+close rounds on one listener, and
two rounds of "server writes and closes, client `read_to_end`s, reconnects".
Both pass on macOS. `http.test.yo` is re-gated with `SkipWindows` so the leg
reaches `tests/net` (it runs after `tests/http`); `tls.test.yo` stays un-gated
because its live handshake passed. Whichever probe hangs on Windows names the
runtime path to fix in `src/codegen/async/`.

### Round 2 (2026-09-06 14:20 CST)

`test (windows-latest)` on #443 **passed in 29 min** with both round-1 probes
in place: a listener accepting three sequential connections, and a client
reconnecting after the server closes, both work on Windows x64 (the arm leg
was still running). So neither repeated `accept` nor reconnect-after-close is
the hang by itself. The redirect test's remaining distinctive shape is the
server running as a SPAWNED task whose `accept` is already PENDING when the
client connects, reading the request up to the blank line, then writing and
closing — three rounds. Two more probes in `tests/net/tcp.test.yo` reproduce
exactly that in raw TCP ("accept pending in a spawned task before the client
connects", "three request/response rounds against a spawned scripted
server"). Both pass on macOS. If these hang on Windows, the defect is in how
`runtime_io_windows.yo` completes an `AcceptEx` that was armed BEFORE the
peer connected (or a `read` armed before data arrives) when another task on
the same loop is the peer.

### Round 2 verdict (2026-09-06 16:00 CST)

Both Windows legs of #443 (run with `de2385960`) were cut at the 75-minute
deadline. Their logs show the two round-1 probes PASSING on both
`windows-latest` and `windows-11-arm`, and then nothing: **the first round-2
probe — "accept pending in a spawned task before the client connects" — is
the hang**, on both architectures. The probe's own progress lines were lost
with the killed process's stdout buffer, so `de2385960`'s logs cannot say how
far it got; the follow-up commit prints them to stderr, so the next run's log
will show whether the server task ever printed `server: accept 0 pending`
(the spawned task was polled and armed the accept) and whether the client
got past `connect` / `write` / `read_to_end`.

The shape that hangs, precisely: `server := io.spawn(task)` where the task's
first await is `listener.accept`; then, on the SAME event loop,
`io.await(TcpStream.connect(addr))`, `write_str`, `read_to_end`. Plain
sequential accept-then-exchange (round 1) works, so the suspects are, in
order: (1) an `AcceptEx` armed while no connection exists is never completed
when the connection later arrives from the same loop (`__yo_async_accept_start`,
`runtime_io_windows.yo:3181`); (2) the spawned task is never polled once main
blocks in `__yo_io_wait` on the client's read; (3) the loop-back `connect`
completing synchronously on Windows (`ConnectEx` on a bound listener) and the
completion packet being dropped. Read the stderr lines of the next run first.

### Root cause (2026-09-06 16:10 CST) — `accept` blocked the event loop

`src/codegen/async/runtime_io_windows.yo`'s `__yo_async_accept_start` was a
plain **blocking `accept()`** on the loop thread (and `connect_start` a
blocking `connect()`), wrapped in an already-completed future. Every
"async" accept therefore blocked the whole single-threaded event loop until a
peer connected:

- round 1's probes and every pre-existing TCP test connect FIRST and accept
  second — `accept()` returns at once, nothing notices;
- the redirect test and the round-2 probe spawn the server task first, so its
  `accept` runs while the client — on the SAME loop — has not connected yet.
  `accept()` blocks the thread; the client's `connect` never runs; the leg
  hangs until the job deadline. Both architectures, deterministically.

The Schannel work was never the problem; it just un-skipped the first test
with this shape.

**Fix (pushed to `d6/step2-unskip`):** an overlapped `AcceptEx` path. The
extension pointers (`AcceptEx`, `GetAcceptExSockaddrs`) are fetched through
`WSAIoctl(SIO_GET_EXTENSION_FUNCTION_POINTER)` — `<mswsock.h>` for the
typedefs, no new import library, so the four Windows link-flag sites stay
untouched. The overlapped record gains an `is_accept` branch: on completion
the accepted socket gets `SO_UPDATE_ACCEPT_CONTEXT`, the peer address is
copied out via `GetAcceptExSockaddrs`, and the socket joins the completion
port with `FILE_SKIP_COMPLETION_PORT_ON_SUCCESS` exactly as the old path did;
a synchronous `AcceptEx` return is finished inline. The blocking `accept()`
remains only as the fallback when the extension cannot be fetched.
`connect_start` is still the blocking `connect()` — harmless for loopback
(completes immediately) but the same class; `ConnectEx` is the follow-up.
