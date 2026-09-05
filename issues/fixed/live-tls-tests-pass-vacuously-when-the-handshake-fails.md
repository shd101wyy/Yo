# The live-TLS tests pass vacuously when the handshake fails — in CI too

**Found** 2026-09-04, while removing the `SkipWindows` pragmas for the Schannel
backend (D6, `plans/D6_TLS_PLAN.md` item 3).

**Class:** hollow green. Not a wrong answer — an *absent* answer that reads as a
pass.

## What is wrong

`tests/crypto/tls.test.yo`'s "live TLS fetch of example.com (skips offline)" and
`tests/http/http.test.yo`'s "fetch over https returns a real response (skips
offline)" both install a `throw` handler that prints a note and `unwind`s:

```rust
exn := Exception(
  throw : (
    err -> {
      println(`  https fetch skipped (no egress?): ${err.to_string()}`);
      unwind(());
    }
  )
);
resp := io.await(fetch(`https://example.com`.to_string(), io), IoExn(io : io, exn : exn));
reached.* = true;
...
cond(
  reached.* => assert(ok.*, `expected a 200 ...`),
  true => assert(true, "skipped: no network")
);
```

`unwind(())` **discards the continuation and exits the enclosing fn** — the test
body. So the trailing `cond` never runs on the failure path: the `reached.*`
guard is dead code, and *every* TLS failure — an offline box, a broken
handshake, a certificate regression, a backend that was never wired up — ends
the test with no assertion at all. The runner counts it green.

The comment says the design is "skips when the connection can't be made so an
offline box stays green", which is a reasonable intent. The defect is that the
test cannot tell an offline box from a broken TLS stack, so it treats a
regression as an offline box **on the CI runners as well**, where egress is
guaranteed (`plans/D6_TLS_PLAN.md` §7: "CI runners have egress; offline boxes
skip").

## Why it matters now

This is the audit's own C34 lesson (`json_parse` accepting `"<html>"` as `0`
"looked green for months" because the number path had no negative test), applied
to the whole TLS surface:

- Every https assertion in the suite is one of these two tests. If TLS breaks,
  nothing in CI goes red.
- It blocks the Schannel work directly: removing `pragma(Pragma.SkipWindows)`
  from these files would give a *Windows green that proves nothing* — a Schannel
  backend that fails every handshake looks exactly like a Windows runner with no
  egress.

## The fix

Two parts, both in the tests:

1. **A deterministic, network-free gate**: assert `tls_available()` under CI.
   Schannel ships with Windows and the unix CI legs link OpenSSL, so a `false`
   there is unambiguously a build/wiring regression. This is the assertion that
   catches "the backend was never wired up", and it cannot flake.
2. **Make the live handshake mandatory under CI**: the handler asks a
   module-level `_network_required()` (true when `CI` is set) and `panic`s with
   the real error instead of unwinding. A module-level binding is reachable from
   a capture-free `->` handler (that is what #396 established), so the handler
   does not need to capture anything.

Use `eprintln`, not `println`, for the diagnostic: a buffered `println` inside a
handler is LOST when the panic aborts the child.

Deliberate trade-off, recorded so it is not "fixed" back: making the live test
mandatory under CI accepts that an egress hiccup on a runner turns a leg red,
where today it is invisible. A red leg is retryable and visible; a vacuous pass
is neither.

## FIXED 2026-09-04 (with the Schannel backend, `plans/D6_TLS_PLAN.md`)

Both test files now carry a module-level
`_network_required :: (fn() -> bool)(env.get("CI").is_some());`, and their
handlers branch on it: under CI they `eprintln` the real error and `panic`;
otherwise they print the note and `unwind` as before.

`tests/crypto/tls.test.yo` also gained the network-free half — **"a TLS backend
is present wherever one can be"** asserts `tls_available()` under CI. That is
the assertion that cannot flake and cannot be vacuous: Schannel ships with
Windows and the unix CI legs link OpenSSL, so a `false` there is a build or
wiring regression, full stop.

`pragma(Pragma.SkipWindows)` is gone from both files, so Windows now runs the
TLS tests **and** the whole HTTP suite (loopback client, server, chunked
bodies) for the first time — that skip had covered the entire `http.test.yo`
file, not just its https test.
