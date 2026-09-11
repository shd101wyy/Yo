# `Url.parse` collapses an empty authority host to `.None`, so `file:///a/b` has no path segments

**Status:** open. Found while writing `///` docs for `std/url/index.yo` (the
2026-09-11 std doc sweep). Documentation-only PR — filed, not fixed.

## What happens

`Url.parse` stores the host as `Option(String)` and has no separate record of
whether the input had a `//` authority at all. An authority whose host is
empty therefore parses to the same `_host = .None` as an opaque URI that has
no authority:

```
Url.parse("mailto:a@b")   -> _host = .None    (correct: no authority)
Url.parse("file:///a/b")  -> _host = .None    (wrong-ish: authority, empty host)
```

Two observable consequences.

### 1. `path_segments()` answers `.None` for `file:///a/b`

`path_segments` gates on `self._host.is_none()` (`std/url/index.yo`, the
`path_segments` inherent) to mean "cannot be a base". For `file:///a/b` that
test now fires on the wrong reason:

```
file:///a/b   host().is_some() = false   path_segments().is_some() = false
```

Rust's `url` crate answers `Some(["a", "b"])` for the same input —
`cannot_be_a_base()` is false for `file:///a/b`, and `host_str()` is
`Some("")`. A `file:` URL is the single most common empty-authority URL, so
this is not a corner: every caller walking a `file:` URL's path segments gets
`.None` and has to fall back to splitting `path()` itself.

### 2. The empty host is asymmetric — `.Some("")` with a port, `.None` without

In `parse`'s authority branch the three host paths do not agree on what an
empty host means:

* IPv6 branch — `host = .Some(...)` unconditionally.
* `host:port` branch — `host = .Some(host_b)` unconditionally, so an empty
  host before the colon is `.Some("")`.
* no-colon branch — `.Some(h)` only `cond(!h.is_empty() => ...)`, so an empty
  host is dropped to `.None`.

```
http://:80/x  ->  host() = .Some("")   (len 0)
http:///x     ->  host() = .None
```

The same URL shape (authority present, host empty) answers two different ways
depending on whether a port happens to be written. Whichever answer is right,
one of these two is wrong.

## Reproducer

`issues/repros/stddoc-io-url-empty-host-collapses-to-none.yo`

```
$ yo compile issues/repros/stddoc-io-url-empty-host-collapses-to-none.yo \
    --std-path ./std --optimize 2 -o /tmp/t && /tmp/t
file:///a/b   host_is_some=false  path_segments_is_some=false
http://:80/x  host_is_some=true   host=""
http:///x     host_is_some=false
```

Expected (Rust's `url` as the reference):

```
file:///a/b   host_is_some=true   path_segments_is_some=true
http://:80/x  host_is_some=true   host=""
http:///x     host_is_some=true   host=""
```

## Root cause

`Url`'s five stored components carry no "authority present" bit:

```rust
Url :: ref(
  struct(
    _scheme : String,
    _host : Option(String),
    ...
  )
);
```

`_host : Option(String)` is being asked to answer two independent questions —
"was there an authority?" and "was the host non-empty?" — and can only encode
one. `parse` resolves the ambiguity toward "no authority" in the no-colon
branch and toward "empty host" in the other two.

Note the internal `_UrlRef` (used by `join`) gets this RIGHT: its
`authority : Option(String)` is `.Some("")` for `//` with nothing after it, and
its doc comment says explicitly that "not present" and "present and empty" are
different. `Url` itself lost the distinction.

## Suggested fix (not applied)

Either shape works and both change what `host()` returns, so this is an API
decision, not a local patch:

1. Make an empty authority host `.Some("")` in all three branches, matching
   Rust's `host_str()`, and give `path_segments` its own
   `_has_authority : bool` field (or a `cannot_be_a_base()` predicate) rather
   than inferring it from the host.
2. Keep `host()` as-is and add the explicit `_has_authority` bit, so
   `path_segments` stops asking the host a question the host cannot answer.

Option 1 is Rust's shape. `std/url/index.yo`'s `## Stability` section names
this as the module's open question, so the marker is already honest about it.

## Also worth a look while in this code

`parse` splits the authority at its FIRST `@`, where the WHATWG URL Standard
(and so Rust's `url`) splits at the LAST: `http://a@b@h/` is userinfo `a`,
host `b@h` here and userinfo `a@b`, host `h` there. Documented at `userinfo()`
rather than changed. The old `set_userinfo` doc comment asserted the LAST-`@`
rule and gave a consequence that matched neither reading; that doc was
corrected in the same sweep.
