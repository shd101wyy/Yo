# `tests/http/http_limits.test.yo`'s redirect tests fetched `httpbin.org`, so a third-party outage failed the Linux suite

**Status:** FIXED 2026-09-08. Found on PR #491's `test (ubuntu-latest)` leg
(a run whose only change was to the LSP and the type renderer). **Severity:**
CI flake on a required check.

## Symptom

```
✗ a redirect chain over the cap throws TooManyRedirects
    Test failed with exit code 134
    a 15-hop redirect must throw TooManyRedirects (at std/assert.yo:25:17)
```

The same test passed locally against the PR's binary, and it had passed on
develop's last completed run (742474f57).

## Root cause

The test fetched `https://httpbin.org/redirect/15` and asserted that the
resulting error mentions `Too many redirects`. Any OTHER outcome from the
public host — a 503, a rate limit, a TLS/DNS hiccup, a 200 — trips the same
assertion, so the check measured httpbin's availability as much as the client's
redirect cap. Its sibling ("under the cap … 200") had a "skipped (no egress?)"
fallback, which makes it vacuous exactly when the network misbehaves.

## Fix

Both redirect tests now drive a loopback `HttpServer` (the pattern
`tests/http/server.test.yo` already uses): the handler answers `/r/<n>` with
`302 Location: /r/<n-1>` while `n > 0` and `200 done` at `/r/0`. The over-cap
test fetches `/r/15` against the default cap of 10 and asserts both the
`TooManyRedirects` throw and that the server saw exactly eleven requests (ten
followed hops plus the one that trips the cap — pinning the client's counting
rule); the under-cap test fetches `/r/3` and asserts the final 200 and body. No
egress, no skip path, deterministic.

The timeout test (1 ms against `example.com`) and the response-size test
(16-byte cap against `example.com`) still reach the network: a loopback
handler is synchronous and shares the single-threaded loop, so it cannot
delay a response to exercise the deadline. Left as they were.
