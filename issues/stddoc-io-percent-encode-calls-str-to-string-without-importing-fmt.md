# `std/encoding/percent.yo` fails `yo check` on its own — `str.to_string()` with no `std/fmt` import

**Status:** open, and **PRE-EXISTING on `develop`** (verified against HEAD, see
below). Found while writing `///` docs for `std/encoding/percent.yo` (the
2026-09-11 std doc sweep). Documentation-only PR — filed, not fixed.

## What happens

```
$ yo check std/encoding/percent.yo --std-path ./std
error: No matching call found with arguments:
(_HEX_UPPER.to_string)()
   --> std/encoding/percent.yo:49:20
   |
49 |   hex := _HEX_UPPER.to_string().as_bytes();
   |                    ^
yo: error: check: 1 file(s) failed evaluator coverage
```

(Line 49 at HEAD; the doc sweep's `//!` header shifts it to 77. The error is
byte-identical either way.)

## Proof it is pre-existing, not a sweep regression

Five agents are editing `std/` concurrently in this worktree, so the first
suspicion was an in-flight change to `std/string` or `std/fmt`. It is not.
HEAD's own tree reproduces it:

```
$ git archive HEAD std | tar -x -C /tmp/headstd
$ yo check /tmp/headstd/std/encoding/percent.yo --std-path /tmp/headstd/std
error: No matching call found with arguments:
(_HEX_UPPER.to_string)()
   --> /tmp/headstd/std/encoding/percent.yo:49:20
```

`std/fmt/to_string.yo` itself checks clean in the working tree, and its
`impl(str, ToString(...))` (line 312) is present and untouched by the sweep
(`git diff std/fmt/to_string.yo` shows only `///` and `//!` additions).

## Root cause

`_HEX_UPPER` is a `str`:

```rust
_HEX_UPPER :: "0123456789ABCDEF";
...
hex := _HEX_UPPER.to_string().as_bytes();
```

`str`'s `to_string` comes from `impl(str, ToString(...))` in
**`std/fmt/to_string.yo`**, and `percent.yo` imports only

```rust
{ String } :: import("../string");
{ ArrayList } :: import("../collections/array_list");
utf8 :: import("./utf8");
```

none of which reaches `std/fmt`, directly or transitively. A scratch file with
exactly those three imports and a single `"abc".to_string()` reproduces the
error, so it is the import closure and not anything about `percent.yo`'s own
code.

The module therefore is not self-contained: the call resolves only when some
OTHER module in the same program has imported `std/fmt`. That is true of
almost every real program (anything that prints), which is why
`tests/encoding/percent.test.yo` passes and nothing has noticed. It is not
true of `yo check` on the file alone.

## Two ways to fix (neither applied)

1. **Add the import** — `{ ToString } :: import("../fmt");` — the minimal fix,
   and what makes the module honest about what it depends on.
2. **Drop the call** — better, because it is pointless work: `_HEX_UPPER` is
   already a `str` and `str` already has `bytes(i)` (this file's sibling
   `std/encoding/hex.yo` uses exactly that: `hex_chars.bytes(hi)`). The
   `to_string().as_bytes()` round-trip allocates a `String` to reach bytes it
   already had, once per `percent_encode` call.

Option 2 is a code change rather than an import fix, so it needs its own PR
and a look at whether the resulting `ArrayList(u8)` vs `str.bytes()` typing
lines up.

## Worth checking in the same pass

Whether other `std` modules have the same latent hole — a method call whose
`impl` lives in a module outside their own import closure. `yo check` on each
`std` file individually would find them; the whole-tree `yo check ./std`
would NOT, because one file's import of `std/fmt` registers the impl for the
whole run. That difference is why this class of bug survives.
