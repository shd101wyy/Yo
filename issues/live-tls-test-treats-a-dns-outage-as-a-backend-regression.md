# The live TLS/HTTP tests turn a runner DNS outage into a red battery

**Status:** open — **THREE occurrences in one day; now repeatedly blocking the merge queue**
**Found:** 2026-09-15, on PR #695 and PR #692 simultaneously; again on PR #697

| PR | leg | test | result |
| --- | --- | --- | --- |
| #692 | `test (macos-26-intel)` | `live TLS fetch of example.com` | 1238 passed / 1 failed |
| #695 | `test (macos-26-intel)` | `live TLS fetch of example.com` | 1238 passed / 1 failed |
| #697 | `test (macos-26-intel)` | `fetch over https returns a real response` | 1897 passed / 1 failed |

The third hit the `tests/http/http.test.yo:137` twin rather than the TLS one,
confirming the defect is the SHARED classification logic and not one test: both
gate on `env.get("CI").is_some()` alone and both see the error only as a
rendered string. Each occurrence costs a full rerun of an ~80-minute leg.

## Symptom

`test (macos-26-intel)` failed on two unrelated branches within hours of each
other, with the same message and an otherwise perfect battery:

```
1238 passed
1 failed
  ✗ live TLS fetch of example.com (mandatory under CI)
    TLS FAILED where the network is required: DNS lookup failed: example.com
```

27 of 28 checks green on both PRs. Nothing in either branch touches TLS, HTTP,
or the network stack.

## Root cause

`tests/crypto/tls.test.yo:49` (and its twin `tests/http/http.test.yo:137`)
decides "is this failure fatal?" from **one bit — whether `CI` is set**:

```yo
_network_required :: (fn() -> bool)(env.get("CI").is_some());
...
cond(
  _network_required() => {
    eprintln(`  TLS FAILED where the network is required: ${detail}`);
    panic(`live TLS handshake failed under CI — see the message above`);
  },
  true => { eprintln(`  tls test skipped (no egress?): ${detail}`); unwind(()); }
);
```

The handler receives the error only as a **rendered string** (`err.to_string()`),
so every failure mode collapses into the same branch. Under CI that means

- a genuinely broken/unwired TLS backend (the regression this test exists to
  catch), and
- the runner losing name resolution for 30 seconds,

are reported identically and both block the merge queue.

`std/net/errors.yo:85` already distinguishes them — `.DNSFailed` is its own
variant, rendered as `DNS lookup failed: ${msg}`. The information is present and
is being discarded at the test boundary.

## Why the obvious fix is wrong

Do **not** relax this to "warn under CI". The strictness is hard-won: these
tests previously unwound out of the body on every error, so the trailing `cond`
was dead code and a broken backend passed with **no assertion at all**
(`issues/fixed/live-tls-tests-pass-vacuously-when-the-handshake-fails.md`).
Any change here must keep that property — a broken backend must still fail
loudly under CI.

## The fix that keeps both properties

Branch on the error **variant**, not on the rendered string:

- `.DNSFailed` under CI → **skip** (it is the "no egress" case the test already
  knows how to handle; name resolution is not the backend under test).
- handshake / cert / I/O / connect errors under CI → **panic**, exactly as today.

A broken TLS backend cannot produce `.DNSFailed` — resolution happens before the
handshake — so the anti-vacuity guarantee is untouched, and the flake goes away.

`tests/crypto/tls.test.yo:38` ("a TLS backend is present wherever one can be")
is network-free and already asserts the wiring unconditionally under CI, so it
remains the real regression gate either way.

## Verification

Red-first: force `.DNSFailed` (point the test at an unresolvable host) with `CI`
set and confirm the suite currently FAILS; after the fix it must SKIP. Then force
a handshake error with `CI` set and confirm it still FAILS — otherwise the fix
has reintroduced the vacuous pass.
