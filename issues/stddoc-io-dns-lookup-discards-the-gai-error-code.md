# `lookup_host` throws away the `getaddrinfo` error code, so a retryable failure is indistinguishable from a permanent one

**Found:** 2026-09-11, during the `std/` `///` doc sweep (agent A4, net/http/io group).
**Status:** open. Filed, not fixed — the sweep is documentation-only.

## Behaviour

Every DNS failure — no such host, temporary resolver failure, no address of
the requested family, resolver out of memory — arrives at the caller as the
same value, carrying the hostname instead of the reason:

```
NetError.DNSFailed(host)      // to_string(): "DNS lookup failed: <host>"
```

## Root cause

`std/net/dns.yo:41-47`:

```rust
ret := e.io.await(IO_dns.getaddrinfo(host_cstr, .None, .None, result_ptr), e.io);
cond(
  (ret != i32(0)) => {
    IO_dns.free_result(result_ptr);
    e.exn.throw(dyn(NetError.DNSFailed(host)));
  },
  true => ()
);
```

`ret` IS the reason and it is discarded. The sys layer documents that it
carries it — `std/sys/dns.yo:6-8`:

```
//! All async operations return `IoFuture` which resolves to:
//! - 0: success
//! - Non-zero: raw `gai_error` code (`EAI_NONAME`, `EAI_AGAIN`, etc.)
```

`NetError.DNSFailed(msg : String)`'s payload is spelled `msg`
(`std/net/errors.yo:34`) and is given the HOST, so even the string form says
nothing about what went wrong.

## Why it matters

`EAI_AGAIN` is the retryable case and `EAI_NONAME` is the permanent one; the
whole point of distinguishing them is that a client should back off and retry
the first and fail fast on the second. With one variant carrying no code,
neither decision is expressible, and a caller can only retry everything or
retry nothing.

This is the same defect that was filed and fixed for
`IoError.Other(code)` discarding its OS error code
(`issues/fixed/ioerror-other-discarded-its-os-error-code.md`) — the code was
available at the throw site and dropped.

## Fix sketch (not applied)

Keep `ret` in the error. Either `DNSFailed(host : String, code : i32)` or a
typed `DnsError` enum mapping the `EAI_*` set (`NotFound`, `TryAgain`,
`NoData`, `Fail`, `Other(code)`), with `to_string` rendering
`gai_strerror(code)`. Note `std/net/errors.yo` derives its messages
(`derive(NetError, Error(...))`, messages in DECLARATION ORDER), so changing
the variant's fields means updating that arm in the same edit.

Both shapes are breaking for anyone matching `DNSFailed`, so this belongs with
the `NetError.Other`/`AddrParseError` decision that `std/net/errors.yo`'s
`## Stability` section already names, rather than as a standalone change.

Test coverage to add: a lookup of a syntactically valid but nonexistent name
asserts the permanent variant. Note the existing test
(`tests/net/dns.test.yo`, "lookup_host invalid host fails") cannot assert
this: on a machine whose resolver wildcards NXDOMAIN, the lookup SUCCEEDS —
observed on the box this was found on, which resolved
`this.host.does.not.exist.invalid` to 2 addresses. Use a name in a
guaranteed-NXDOMAIN zone (`.invalid` is reserved for exactly this, so the
wildcarding resolver is the anomaly) and tolerate the wildcard case explicitly.
