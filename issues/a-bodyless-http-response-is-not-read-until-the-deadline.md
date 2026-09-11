# A body-less HTTP response reaches the socket and the client's read never completes — macOS, timing-dependent

**Found**: 2026-09-11, by the server-side checkpoints added to
`tests/http/http.test.yo` for #556. **Class**: a lost read wake-up in the
async runtime, visible as a ten-second `HttpError.Timeout` on an exchange that
completes in ~1 ms. **Status**: OPEN.

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

## Where to look

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
