# `std/regex` accepts the `g` and `u` flags and ignores them

**Status:** open (found by the `std/` `///` doc sweep, 2026-09-11)
**Files:** `std/regex/flags.yo` (parses them), `std/regex/vm.yo` and
`std/regex/index.yo` (never read them)

## Behaviour

`RegexFlags` has six fields. Grepping every reader outside `flags.yo`:

```
std/regex/index.yo   _flags.sticky (×4), flags.ignore_case
std/regex/vm.yo      _flags.ignore_case (×5), _flags.multiline (×2), _flags.dot_all (×2)
```

`global` and `unicode` appear nowhere outside the parser that sets them. So
`Regex.new_with_flags(pattern, "gu")` compiles happily and behaves exactly
like `Regex.new(pattern)`.

Verbatim output of the reproducer:

```
Xaa
true
false
true
```

- Line 1: `new_with_flags("a", "g").replace("aaa", "X")` → `Xaa`. The `g` had
  no effect; `replace` is first-match-only by design (Rust's
  `Regex::replace`), and `replace_all` is the all-matches method.
- Line 2: `u` accepted, no effect — the VM decodes UTF-8 and matches whole
  runes unconditionally, so there is no non-unicode mode to switch out of.
- Lines 3–4: the `i` flag IS honoured but folds ASCII only (`NfaVm._to_lower`
  maps `A-Z` → `a-z`), so `é` does not match `É` while `a` matches `A`.

## Why it matters

`g` is the flag a JavaScript-trained caller reaches for to mean "all
occurrences", and the API accepts it without complaint. The failure is silent
and the wrong result is plausible: a sanitiser written as
`Regex.new_with_flags(bad, "g").unwrap().replace(input, "")` removes the first
occurrence only and looks like it worked.

Accepting a flag and doing nothing is strictly worse than rejecting it —
`InvalidFlag` already exists and would have caught this at `Regex.new` time.

## Root cause

`std/regex/flags.yo`'s `parse` recognises all six of `gimsuy` because the
flag vocabulary was copied from JavaScript, but the engine that consumes
`RegexFlags` was written around method choice (`find` vs `find_all` vs
`find_iter`) rather than a `lastIndex` cursor, so there was never anything for
`global` to switch. `unicode` is vestigial in the same way: JavaScript needs
the flag because its default mode matches UTF-16 code units, and Yo's VM has
no such mode.

## Suggested fix

Reject them: remove `g` and `u` from `parse`'s accepted set so they return
`.Err(RegexError.InvalidFlag(b))`, and delete the two dead fields. That is a
breaking change for any caller currently passing them (who is, by
construction, getting nothing from them), and it converts a silent wrong
answer into a compile-time-visible `Result`.

The alternative — implementing `g` as a stateful `lastIndex` on the `Regex` —
should NOT be done: it would make a compiled `Regex` mutable and
non-shareable, which is precisely the design JavaScript is criticised for and
which Rust's regex crate avoids by having `find_iter`.

Separately, the ASCII-only `i` fold is a divergence from Rust's regex crate
(which does Unicode simple case folding by default). `std/string/unicode.yo`
already has the generated tables `_to_lower` would need. Fixing that changes
what existing `i` patterns match, so it belongs in the same decision.

## Reproducer

`issues/repros/stddoc-str-regex-g-and-u-flags-are-silently-ignored.yo`

## Not fixed here

Found during a documentation-only sweep. `std/regex/flags.yo`'s module header
and per-field docs now state which flags are honoured and which are inert, and
the `## Stability` sections of `flags.yo` and `regex/index.yo` name the open
decision; the behaviour is untouched.
