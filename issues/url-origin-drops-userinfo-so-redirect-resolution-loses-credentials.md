# Redirect resolution rebuilds the authority from `origin()`, which drops the base URL's userinfo

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: papercut** — the component loss is real and reproduced,
but nothing on the wire changes *today* because `_fetch_once` never reads
`userinfo` (there is no Basic-auth support). It becomes a live wrong-value the
moment the client uses credentials, or exposes the final URL of a redirect
chain.

## Reproducer

```rust
open(import("std/string"));
{ Url, UrlError } :: import("std/url");
{ Error, AnyError, Exception } :: import("std/error");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  exn := Exception(
    throw : (
      err -> {
        println(String.from("THREW"));
        unwind(());
      }
    )
  );
  u := Url.parse(String.from("http://user:pw@example.com/a"), exn);
  s := u.to_string();
  ui := match(u.userinfo(), .Some(x) => x, .None => String.from("<none>"));
  o := u.origin();
  println(`to_string : ${s}`);
  println(`userinfo  : ${ui}`);
  println(`origin    : ${o}`);
});
export(main);
```

```
$ yo compile repro.yo --optimize 2 -o repro.out && ./repro.out
to_string : http://user:pw@example.com/a
userinfo  : user:pw
origin    : http://example.com
```

The userinfo is parsed and stored, `ToString` emits it, and `origin()` does
not. Resolving `Location: /b` against that base therefore yields
`http://example.com/b`, while RFC 3986 §5.2.2 requires
`T.authority = Base.authority` — and §3.2 defines
`authority = [ userinfo "@" ] host [ ":" port ]`.

## Root cause

`origin()` (`std/url/index.yo:419-430`) is by design the RFC 6454 origin:
scheme + host + port, no credentials. That is correct for what it is called.

The defect is that redirect resolution uses it as if it were the authority.
`_resolve_location` (`std/http/client.yo:217-237`) re-derives the base
authority as a *string* —

```rust
base := Url.parse(base_str, exn);   // std/http/client.yo:221
origin := base.origin();            // std/http/client.yo:222
```

— and then concatenates: `${origin}${location}` for an abs-path reference
(`std/http/client.yo:224`) and `${origin}${dir}${location}` for a relative one
(`std/http/client.yo:233`). Every hop through a relative `Location` therefore
strips whatever `origin()` does not carry. Userinfo is the component that is
lost today; anything else added to the authority later would be lost the same
way.

The structural cause is that resolution works on concatenated strings rather
than on the parsed components it already has in hand.

## Fix

Do **not** change `origin()` — `scheme://host[:port]` is the right definition
(it is what a `Referer`/CORS/`Origin` computation needs, and callers depend on
credentials *not* leaking into it).

Fix the consumer: implement `Url.join(self, reference)` (RFC 3986 §5.2.2) in
`std/url/index.yo` over parsed components, carrying `_userinfo`, `_host` and
`_port` from the base whenever the reference has no authority of its own, and
delete `_resolve_location` (`std/http/client.yo:217-237`) in favour of a
`Url.join` call at `std/http/client.yo:283`. See
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md` for
the full branch table.

While there: if `Url` grows a `with_*` setter family, remember it is
`ref(struct(...))` (`std/url/index.yo:84`) — reference semantics, so a
`self.x = v; self` builder would mutate the caller's base URL in place. Setters
must clone first.

## Regression test

`tests/url/url.test.yo`: `Url.parse("http://user:pw@a/b/c").join("/d")` must
round-trip to `http://user:pw@a/d`, and `.join("e")` to
`http://user:pw@a/b/e`. Keep the existing `origin()` assertion at :314
unchanged — it is pinning the correct behaviour of a different function.

## Related

Four other defects in the same function, each with its own doc:
`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`,
`network-path-redirect-location-resolved-against-the-base-host.md`,
`redirect-resolution-never-removes-dot-segments.md`,
`empty-path-redirect-location-drops-the-base-paths-last-segment.md`.
One `Url.join` implementation fixes all five; land them as one PR.
