# `unicode_to_lowercase` / `unicode_to_uppercase` leave every non-ASCII letter unchanged

**Status:** OPEN. Found 2026-08-25 while routing `std/string/unicode.yo` through
the new `std/encoding/utf8.yo` (STD_API_AUDIT D8). **Pre-existing — not caused by
that change** (A/B below).

## Symptom

```rust
{ unicode_to_lowercase, unicode_to_uppercase } :: import("std/string/unicode");

println(unicode_to_lowercase(`HELLO WÖRLD ẞ`));   // hello wÖrld ss
println(unicode_to_uppercase(`hello wörld ß ﬁ`)); // HELLO WöRLD SS FI
```

`Ö` and `ö` come through untouched. The module's own doc comment advertises
`unicode_to_lowercase(`HELLO WÖRLD`) // "hello wörld"`, so the documented
example does not hold.

Note what *does* work: the hand-written special-case tables (`ẞ`→`ss`,
`ß`→`SS`, `ﬁ`→`FI`) fire correctly, and so does ASCII. Only the general path
fails.

## Root cause

The general path is C's `towlower`/`towupper` (`std/string/unicode.yo`, declared
via `c_include("<wctype.h>", …)`). Those are **locale-sensitive**, and a Yo
program never calls `setlocale(LC_CTYPE, "")` — so the process stays in the
default `"C"` locale, whose `towlower`/`towupper` map only `A`–`Z` / `a`–`z` and
return every other argument unchanged. `towlower(0x00D6)` returns `0x00D6`.

## Not caused by the D8 routing

`std/string/unicode.yo`'s private `_decode_utf8`/`_encode_utf8` were replaced by
`utf8.decode_lossy` / `utf8.encode_lossy_into`. A/B of the same driver, same
binary, only that file stashed:

```
BEFORE: hello wÖrld ss / HELLO WöRLD SS FI
AFTER:  hello wÖrld ss / HELLO WöRLD SS FI
```

Byte-identical — the routing is behaviour-preserving and the defect predates it.

## Why nobody noticed

`std/string/unicode.yo` has **zero consumers in the whole tree** and **zero
tests**. `String.to_lowercase` / `to_uppercase` (`std/string/string.yo`) are a
separate, deliberately ASCII-only implementation and do not call this module.

## Fix options

1. **Ship a real case-mapping table.** The Unicode simple case mappings are a
   few thousand entries; the `html_entities.yo` static-data-blob technique
   (C11 fix, 2026-08-24) is the precedent for shipping that much data without
   crashing clang.
2. **Call `setlocale(LC_CTYPE, "")` once** during runtime start-up and document
   that case conversion depends on the environment. Cheap, but makes a pure
   string transform depend on `LC_ALL`/`LANG`, gives different answers on
   different machines, and still cannot do the multi-codepoint expansions
   (which is why the special-case tables exist at all).
3. **Delete the module** and fold the special-case tables into
   `String.to_lowercase`/`to_uppercase`, keeping `to_ascii_lowercase`/
   `to_ascii_uppercase` as the honest ASCII pair.

`plans/STD_API_AUDIT.md`'s string row already asks for "Unicode-correct
`to_lowercase` (+ `to_ascii_*` variants)", so this is that row's real content:
the Unicode path does not currently exist, it only appears to.

## Reproducer

`issues/repros/unicode-case-locale.yo`
