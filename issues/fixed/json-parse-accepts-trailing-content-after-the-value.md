# `json_parse` accepts trailing content after the value — `[1,2][3,4]` parses as `[1,2]`

**Status: FIXED** (2026-09-06, `std/encoding/json.yo`).

**Severity: strictness gap, C34 family.** RFC 8259 §2: *"A JSON text is a
serialized value."* One value — anything after it is a parse error. `json_parse`
parses the first value, stops, and never checks that the cursor reached the end
of the input, so it returns `.Ok` for input that is not JSON.

**Found** 2026-09-06, while auditing `std/` for the read-overshoot class fixed in
`issues/http-body-is-not-truncated-to-content-length.md`. It is the same
*shape* — a buffer that may hold more than one message, consumed as if it held
one — but not the same bug: no bytes are misattributed, they are simply ignored.

## Reproducer

```rust
open(import("std/string"));
{ json_parse, json_stringify } :: import("std/encoding/json");
{ Exception } :: import("std/error");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  exn := Exception(throw : (err -> { println(`   Err -> ${err.to_string()}`); unwind(()); }));
  println(`${json_stringify(json_parse("[1,2][3,4]", exn))}`);
  println(`${json_stringify(json_parse("1 garbage", exn))}`);
  println(`${json_stringify(json_parse("[1,2]]]]", exn))}`);
  println(`${json_stringify(json_parse("null null", exn))}`);
});
export(main);
```

```
input: [1,2][3,4]   ->  [1,2]     want an error
input: 1 garbage    ->  1         want an error
input: [1,2]]]]     ->  [1,2]     want an error
input: null null    ->  null      want an error
input: [1,2]        ->  [1,2]     OK
```

Rust's `serde_json::from_str` rejects all four with `trailing characters`.

## Why it matters

This is the same failure mode C34 was filed for — *"an HTML error page where JSON
was expected"*. C34 fixed the number grammar so `"<html>"` no longer parses as
the number `0`, but a response whose first bytes happen to be a valid JSON value
followed by anything at all still parses cleanly. A truncated-then-retried
response, two concatenated frames, or a JSON body with an HTML error appended all
read as success.

## Where to look

`std/encoding/json.yo:782`, `json_parse_bytes`: it returns `.Ok(v)` straight out
of `_parse_value(p)` with no end-of-input check. `json_parse` (`:791`) routes
through it.

## Fix shape, and the thing to check FIRST

After `_parse_value`, skip whitespace and require the cursor to be at the end of
input; otherwise `JsonError` naming the offset.

**Check `src/lsp/server.yo` before tightening anything.** The LSP parses every
JSON-RPC frame through `json_parse`, and if it hands over a read buffer that can
contain the *next* frame's bytes, this tightening would break the language
server outright. That is the over-acceptance canary for this change, and it must
be verified before the fix, not after.

The other canary is cheap and must keep passing: leading and trailing
**whitespace** around a value is legal JSON text (`"  [1,2]  "`), so the
end-of-input check skips whitespace rather than demanding exact length.

## Regression tests

`tests/encoding/json.test.yo`. Four rejections (the reproducer's cases, so the
concatenated-value, junk-suffix, unbalanced-bracket and repeated-literal shapes
are each pinned separately) plus two acceptances — `"  [1,2]  "` and a value with
a trailing newline — so a fix that over-rejects is caught.

## Fix

`_expect_eof(p)` — skip whitespace, then require the cursor to be at end of
input — runs after `_parse_value` in **both** public entry points:
`json_parse_bytes` (so `json_parse` / `json_parse_string` throw) and
`json_parse_result` (so it returns `.Err`). The error is
`JsonError.UnexpectedChar(ch, pos)`, which names the offending byte and its
position, the way `serde_json` reports `trailing characters`.

Whitespace around a lone value is still accepted (`  [1,2]  `), so the check
does not over-reject — pinned by its own test.

## Regression tests

`tests/encoding/json.test.yo`, verified RED before the fix (2 failed / 57
passed) and green after (59 passed):

- `json_parse_result rejects content after the top-level value` — all five
  shapes from the reproducer above.
- `json_parse_result still accepts a lone value with surrounding whitespace` —
  the over-rejection canary.
- `json_parse throws on content after the value, and names the position` —
  asserts the message carries `position 5` for `[1,2][3,4]`.

## Note for the caller in `src/`

`src/lsp/server.yo` parses a Content-Length-framed body with
`json_parse_string`. Stricter parsing is correct there — the body should be
exactly the message — and a trailing `\r\n` is still tolerated because
`_expect_eof` skips whitespace first.
