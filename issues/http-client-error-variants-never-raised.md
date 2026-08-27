# `HttpError` promises three failures the client cannot produce

**Found**: 2026-08-27, during the §7 P0 item 9 (`Duration` integration) survey —
grepping std for timeout surfaces turned up `HttpError.Timeout` with no knob
behind it. **Status**: OPEN.

## The gap

`std/http/client.yo`'s public `HttpError` enum declares, documents and formats
seven variants. Only four can ever be constructed:

| variant | raised at | reachable? |
| --- | --- | --- |
| `UnsupportedScheme` | client.yo:270 | yes |
| `InvalidUrl` | client.yo:278 | yes |
| `ConnectionFailed` | client.yo:288 | yes |
| `Other` | client.yo:343 | yes |
| **`Timeout`** | — | **never** |
| **`TooManyRedirects`** | — | **never** |
| **`ResponseTooLarge`** | — | **never** |

Each dead variant appears exactly twice in the module: its declaration (with a
doc comment describing behaviour that does not exist — "The request timed out",
"Too many HTTP redirects", "The response body exceeds the size limit") and its
`to_string` arm. Nothing constructs them, and `FetchOptions` has no field that
would drive them: it carries `method`, `headers`, `body` and nothing else, so
there is no deadline, no redirect cap and no size limit anywhere in the request
path (`fetch_with`, `_read_http_response`).

Consequences today: a hung server blocks `fetch` forever (no deadline), a 301
response is handed back verbatim rather than followed, and a hostile server can
stream an unbounded body into memory.

This is the C9 class ("`WalkOptions.follow_symlinks` declared, never read") on a
public error type, and it is a §1 stability-contract problem specifically
because S5 is next: freezing this enum locks in three variants that never occur,
and deleting them afterwards is a breaking change.

## Reproducer

```bash
grep -c "Timeout" std/http/client.yo            # 2 — declaration + to_string arm
grep -n "HttpError.Timeout" std src             # no constructor anywhere
```

Behavioural: point `fetch` at a socket that accepts and never answers — it
blocks indefinitely instead of yielding `.Timeout`.

## What a fix needs

Implement the three behaviours rather than delete the variants (P1 already asks
for a "chunked/redirect/timeout client", and item 6 just landed the piece that
makes the first one cheap):

- **Timeout**: `FetchOptions.with_timeout(Duration)`, applied by driving the
  request through `std/async`'s `timeout(handle, limit, io)` (added 2026-08-27,
  §7 P0 item 6) and throwing `.Timeout` when the deadline wins. This is also
  the remaining substance of §7 P0 item 9 — every other timeout/interval
  surface in std already speaks `Duration` (`std/time/sleep`, `std/async`);
  `std/sys/timer.sleep(milliseconds : u64)` stays raw by design as the sys
  layer.
- **TooManyRedirects**: follow 3xx `Location` up to a `FetchOptions` cap
  (default ~10), throwing when exceeded. Note the cross-scheme case: a redirect
  to `https://` must throw `UnsupportedScheme`, not silently downgrade (C1).
- **ResponseTooLarge**: a max-body-bytes option enforced in
  `_read_http_response`, which today appends into an `ArrayList(u8)` with no
  ceiling.

All three are additive (new `FetchOptions` fields + real behaviour), so they can
land without breaking callers — unlike removing the variants, which is why this
should close BEFORE the S5 freeze.
