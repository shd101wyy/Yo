# A body-less HTTP response reaches the socket and the client's read never completes — macOS, timing-dependent

**Found**: 2026-09-11, by the server-side checkpoints added to
`tests/http/http.test.yo` for #556. **Class**: a lost wake-up in the async
runtime, visible as a ten-second `HttpError.Timeout` on an exchange that
completes in ~1 ms. **Status**: OPEN. The "lost READ wake-up" reading is
REFUTED as of 2026-09-12 — the read completes with the whole response in hand
(see "The client-side trace" below); what is lost is one level up.

## What the checkpoints prove

`HttpClient: a 204 ends at its headers, whatever its Content-Length says`, on
`test (macos-latest)`:

```
[204] server spawned, issuing request one
[srv] accepted connection 1
[srv] awaiting a framed request (carry=0)
[srv] framed 38 request byte(s)
[srv] wrote 46 of 46 answer byte(s)        ← the WHOLE response is on the wire
[srv] awaiting a framed request (carry=0)
unexpected exception: HTTP request timed out
```

Three things are therefore ruled out, and this is what the instrumentation was
for:

- **not the connect** — the server accepted;
- **not the request** — the server framed all 38 bytes of it;
- **not the response framing** — the server wrote all 46 bytes, and
  `tests/http/wire.test.yo` frames a 204 at its header section at chunk sizes
  1, 42 and 4096 on every platform.

What is left is the CLIENT's read of a response that is already in the socket
buffer. It does not complete for ten seconds, and the deadline wins.

## Why it is a race and not a framing bug

The same commit passed `test (macos-latest)` on the run before this one. The
only difference between the two runs is the checkpoint `eprintln`s in the test
server. Adding four prints to the server moved the failure onto a runner where
it had been green — so this is timing-sensitive, not deterministic, and the
"which platform fails" pattern (macos-26-intel, then windows-latest, then
macos-latest) is which runner happened to lose the race.

`_KA_204` and `_KA_KEEP`+HEAD are the two shapes that lose it. What is special
about them is not the framing — it is that the server writes a SHORT response
and then immediately parks on the next read, so the client's read is the only
thing the loop has left to wake.

## What did NOT reproduce it

Ruled out locally so the next session does not repeat them:

- The failing test extracted to a standalone `main` with the same server
  helpers, WITH the checkpoints, 40 consecutive runs on aarch64-apple-darwin:
  0 failures. Without the checkpoints, 60 runs: 0 failures.
- The whole `tests/http/http.test.yo` file locally: 51/51.
- An x86_64 build under Rosetta could not be produced — homebrew's OpenSSL is
  arm-only, so `--target x86_64-apple-darwin` fails to link `TLS_client_method`.

## Three suspects EXCLUDED by measurement (2026-09-11)

Recorded so none of them is re-investigated. Each was excluded by comparing
emitted C or by reading the registration flags, not by a passing test.

1. **The two-arm `_Transport.read` dispatch — NO.** The shape (an enum with two
   payload arms, each `n = e.io.await(stream.read(...), e)` over
   differently-shaped futures) was written standalone and emitted with a
   pre-#592 compiler and with #592's: the C is BYTE-IDENTICAL, and both
   binaries compute the right answer over 200 alternating iterations. None of
   #592's six dispatch fixes touch a plain two-arm point.

2. **An edge-triggered readiness registration that misses an edge that already
   happened — NO, not on macOS.** `__yo_io_register_kevent`
   (`src/codegen/async/runtime_io_macos.yo`) issues
   `EV_SET(..., EV_ADD | EV_ONESHOT, ...)` with **no `EV_CLEAR`**, so
   `EVFILT_READ` is LEVEL-triggered: registering it against a socket whose
   buffer already holds the response fires immediately.

3. **The while-loop family — NO.** `read_http_message_buffered`'s read loop is
   an outer `while` whose await is its first statement, with a NESTED `while`
   (no await) inside a `cond` arm after it, both testing the same `done` flag.
   That combination was compared function-by-function between a pre-#592
   compiler and #592+#593: **362 functions on both sides, 0 bodies differ**.
   The only raw-text difference in the whole file is one unreferenced struct
   slot (`__yo_t1 var_N; // io`, 0 uses) that the post-fix suspension analysis
   stops declaring. No store, no read, no branch.

   Worth noting for any future A/B: the compiler's own emission never includes
   this function, because `std/http` is not in `src/main.yo`'s import closure.
   An emit A/B over the compiler tree therefore says nothing about it, and the
   comparison has to be driven from a small program that imports the module.

**That leaves the platform I/O completion path.** The client-side checkpoints
now on this branch answer the remaining question directly: whether the read is
never ISSUED, or issued and never woken.

## The client-side trace (2026-09-12) — the read completes, and the exchange still hangs

Run **34610920605**, job **103332927203**, `test (macos-26-intel)`. The
checkpoints inside `read_http_message_buffered`'s read loop came back, and they
refute the heading of this issue:

```
[204] issuing request two on the pooled connection
[wire] issuing read (have=0)      (D)
[wire] read returned 38           (C')
[srv] framed 38 request byte(s)
[srv] wrote 46 of 46 answer byte(s)
[srv] awaiting a framed request (carry=0)
[wire] issuing read (have=0)      (E)
[wire] read returned 46           (D')
unexpected exception: HTTP request timed out
```

Both peers frame through the SAME function, so the prints interleave. Pairing
them by who can produce which byte count — requests are 38 bytes, responses 46
— the client's read `D` **returned all 46 bytes of the response**, and then
nothing else was printed for ten seconds: not the next loop iteration, not the
test's `[204] response two`.

So the read is issued, the read is woken, and the whole response is in the
client's buffer. "A lost read wake-up" is the wrong heading. What is lost sits
one level UP, and there are exactly two candidates:

1. **The parent await never resumes.** `_do_fetch` awaits
   `read_http_message_buffered(...)` as a nested async-block future. If that
   inner future completes and the continuation registered by the parent's
   await is never invoked, the task stops exactly where the trace stops.
2. **`_fetch_follow` finishes and nobody notices.** `_fetch_deadline`
   (`std/http/client.yo`) does not await the exchange — it spawns it and spins:

   ```rust
   h := e.io.spawn(_fetch_follow(url_str, opts, pool, e.io), e);
   dh := e.io.spawn(sleep(limit, e.io), e.io);
   while(runtime(!h.is_finished() && !dh.is_finished()), {
     e.io.await(yield(e.io), e.io);
   });
   ```

   `is_finished()` reads the spawned future's state word
   (`__yo_join_handle_state_raw`). If the exchange completes and that word is
   not published where this loop reads it, the spin runs until the 1 ms-timer
   `yield`s have burned the whole ten seconds and `dh` wins — which produces
   `HttpError.Timeout` with the request long since answered.

The pairing above is INFERRED, not read off the log, which is a defect in the
instrumentation rather than in the reasoning. The checkpoints therefore now
carry a `REQ`/`RSP` tag (the server frames Requests, the client Responses), a
third print marks the read loop EXITING, and `client.yo` brackets its await on
either side. The next trace separates the two candidates without inference: if
`[wire RSP] loop done` prints and `[clt] parent await resumed` does not, it is
candidate 1; if both print and the deadline still fires, it is candidate 2.

## Earlier hypothesis, now refuted: a two-arm match with an await in each arm

`std/http/client.yo`'s `_Transport.read` is an `io.async` body whose only
await sits inside a `match`, once per arm:

```rust
_Transport :: enum(Plain(stream : TcpStream), Secure(stream : TlsStream));
read : ... io.async(e => {
  (n : usize) = usize(0);
  match(
    self,
    .Plain(stream) => { n = e.io.await(stream.read(buf, size, e.io), e); },
    .Secure(stream) => { n = e.io.await(stream.read(buf, size, e.io), e); }
  );
  n
})
```

That is the DISPATCH-MODE await point — one shared `await_future_N` slot,
branches that await differently-shaped futures, a continuation that has to be
routed back to the arm that suspended. It is the exact family #592 redesigns,
and its six fixed bugs include "a sibling arm's second-await binding never
assigned when its continuation lands in a chained layer" and "bound nested
cond in a chained layer emitted nothing". A continuation that is routed to no
arm is a task that never resumes — which is precisely what the checkpoints
show: the bytes arrive, and the reader never wakes.

It also explains the timing-dependence. Which arm's continuation is emitted as
the representative, and whether the loop delivers the completion inline or
through the ready queue, decides whether the mis-routed path is taken.

**This was wrong** — see exclusion 1 above. #592 landed and the shape it
would have had to fix emits identically on both compilers. Kept because the
reasoning is the right reasoning for the NEXT dispatch-shaped suspicion; only
the conclusion was wrong.

## Where to look, if #592 does not fix it

`__yo_io_process_event` / the kqueue read registration in
`src/codegen/async/runtime_io_macos.yo`, and the deferred changelist
(`__yo_kq_changes`) it batches registrations through. The question to answer
is whether a read registered into the changelist can be left unsubmitted while
the loop decides it has nothing to wait for — i.e. whether there is a window
where `__yo_io_wait()` blocks without having flushed the change that would
have woken it.

The next measurement that would settle it is a client-side checkpoint inside
`read_http_message_buffered`'s loop (before the `stream.read` await and after
it), pushed to CI on the same branch. That says whether the read was issued at
all, or issued and never woken.
