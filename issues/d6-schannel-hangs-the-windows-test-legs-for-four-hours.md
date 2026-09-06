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
