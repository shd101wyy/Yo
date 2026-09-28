# `HttpMethod.from_string` returns `Option`, not `Result` (D12)

**Kind:** design question — an open decision, not a defect. Moved from `issues/` root in the 2026-09-28 severity triage.

**Status: OPEN.** Found 2026-09-09 while renaming `FromStr` → `FromString`.

## Symptom

```rust
from_string : (fn(s : String) -> Option(HttpMethod))(…)
```

D12 decided that string parsing returns a `Result` carrying the type's own
error, "so a caller can tell an EMPTY string from garbage from an out-of-range
value". Every `FromString` impl in `std/string/string.yo` follows that.
`HttpMethod` does not: it is an inherent method returning `Option`, so
`from_string("")`, `from_string("GETT")` and `from_string("get ")` are all the
same `.None`.

Rust's counterpart is a real `FromStr` impl —
`http::Method::from_str -> Result<Method, InvalidMethod>`.

## Why it was left out of the rename PR

The rename was a naming change: same shapes, new spellings, mechanical to
review. Turning this into a `Result` is an ERROR-TYPE design question — does
`HttpMethod` get its own error enum, or reuse `HttpError`, and does it then
become a `FromString` impl rather than an inherent method (which would give it
`s.parse(HttpMethod)` for free)? Those decisions want their own diff.

## Fix sketch

Make it a `FromString` impl with `Err : HttpError` (or a narrower
`InvalidMethod`), so `parts(0).parse(HttpMethod)` is the spelling at the one
call site in `std/http/http.yo:392` and callers get a reason. Keep the
`Option`-returning inherent method for one release only if a caller
demonstrably wants it — the one in-tree caller does not.

Related: the same D1/D12 sweep is still open for the rest of `std/http`
(`StatusCode`, `HeaderMap` — `plans/archive/STD_API_STABILIZATION.md` §4 I/O).

---

## Recommendation (agent triage, 2026-09-28 — awaiting maintainer verdict)

Adopt the doc's own sketch: a `FromString` impl with a narrow `InvalidMethod`
error enum of its own rather than `HttpError` — parsing a method verb is not an
HTTP transport failure, and a narrow error composes upward where `HttpError`
does not fit. That gives `s.parse(HttpMethod)` at the one call site
(`std/http/http.yo:392`) and a reason for every failure spelling, which is what
the D12 decision demands. Drop the `Option`-returning inherent method in the
same PR instead of carrying it a release — the repo has no compatibility
scaffolding and the single in-tree caller migrates with the change. The
`StatusCode`/`HeaderMap` remainder of the D1/D12 sweep belongs in follow-ups,
not this diff.
