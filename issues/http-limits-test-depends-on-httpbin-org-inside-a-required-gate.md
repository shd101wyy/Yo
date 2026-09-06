# `tests/http/http_limits.test.yo` depends on httpbin.org — inside a required ratchet gate

**Status: OPEN** (filed 2026-09-06). Not a compiler bug; a CI-determinism bug.

## Symptom

`Full-corpus hollow sweep` — a REQUIRED check, and a *ratchet* (it fails on any
new regression, on a stale allowlist entry, and on a file that merely CHANGES
verdict) — went RED on PR #452 with:

```
tests/http/http_limits.test.yo RED rc=1 hollow=0 markers=0 4 passed
  ✗ a redirect chain over the cap throws TooManyRedirects
    Test failed with exit code 134
```

#452 changes `btree_map`, `priority_queue` and `process/command`. `std/http`
imports none of them, and the same file passes 5/5 locally on that exact
branch. The test reaches the public internet:

```rust
_r := io.await(fetch(`https://httpbin.org/redirect/15`.to_string(), io), ...);
```

httpbin.org aggressively rate-limits cloud egress, which is precisely what a
GitHub Actions runner is. The 15-hop test issues 16 requests and is therefore
the first to be throttled — note the 1-hop test in the same file passed.

The failure mode is maximally misleading: it is reported against whichever PR
happens to be running, as a *new regression under the self-hosted compiler*.
It already cost one false alarm — `plans/HANDOVER_STD_AUDIT_2026-09-06.md` §8
recorded it as "a NEW regression … which touches btree_map, priority_queue,
process/command and the command test only".

## Why the obvious workaround is wrong

Adding the file to `scripts/bootstrap/known-failing.tsv` does not work and
must not be attempted: the ratchet fails on a verdict *change* in either
direction, so an allowlisted entry would go red on every run where httpbin
DOES answer.

## Fix

Serve the redirects locally. `std/http` has an `HttpServer`, and
`tests/http/server.test.yo` already establishes the spawn-a-loopback-server
pattern. A handler that 302s to `/redirect/{n-1}` until `n == 0` reproduces
httpbin's `/redirect/N` exactly, deterministically, with no egress — and would
let the file drop `Pragma.SkipWindows` (it is skipped there only because the
runners lack OpenSSL for the https endpoints).

Deferred only because PRs #453/#454 reshape `std/http/server.yo`
(`read_http_message -> Result`, `serve_once` answering 413/400); this should
land on top of them rather than conflict with them.
