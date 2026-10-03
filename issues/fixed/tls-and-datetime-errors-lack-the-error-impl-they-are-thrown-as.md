# `TlsError` is thrown as an `AnyError` without implementing `Error` — and `DateTimeError`/`PercentError` are missing the impl too

**Severity:** S3 — the remaining open item (PercentError) has neither ToString nor Error impls — a std error type cannot render (partially fixed)

**Status:** PARTIALLY FIXED 2026-09-05 — items 1 (`TlsError`) and 2
(`DateTimeError`) landed with the `dyn()` bound check (C69,
`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md`), which
turned item 1 from a style violation into a build break. **Item 3
(`PercentError`) was closed 2026-10-03** — see `## Fixed`.
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit
(auditing what `impl(_, Error())` is worth revealed which std types skip it).
**Severity:** papercut today; it becomes a hard compile error in std the moment
`dyn()` starts checking trait bounds
(`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md`).

## Symptom

`AnyError` is `Dyn(Error)` (`std/error.yo:16`). `std/crypto/tls.yo:102` throws
one:

```rust
_throw_tls :: (fn(err : TlsError, exn : Exception) -> unit)(
  exn.throw(dyn(err))
);
```

reached from nine call sites (`std/crypto/tls.yo:172`, `:183`, `:188`, `:214`,
`:223`, `:260`, `:312`, `:322`). But `TlsError` (declared at
`std/crypto/tls.yo:68`, with a hand-written `ToString` at `:81`) has NO
`impl(TlsError, Error())` — `grep -rn "impl(TlsError" std/` returns only the
`ToString`. The throw compiles solely because `dyn()` performs no
trait-satisfaction check.

`DateTimeError` (`std/time/datetime.yo:286`, `ToString` at `:295`) is in the same
state; it is only used in `Result`-style returns today, so nothing dyn's it yet.

`PercentError` (`std/encoding/percent.yo:21`) has neither `ToString` nor
`Error()`.

This is a straight violation of D1 as written in
`.github/instructions/yo-design.instructions.md:500-502`: "An error type is a
real enum implementing `Error()`."

## Measured surface

Of the 18 `*Error` enums declared in `std/`, 9 carry `impl(_, Error())`
(`CryptoError`, `CsvError`, `EncodingError`, `HttpError`, `IoError`,
`JsonError`, `NetError`, `RegexError`, `UrlError`), plus `String` itself at
`std/error.yo:19`. The other 9 split into two groups:

- **Deliberate layering, leave alone**: `AllocError` (`std/allocator.yo:5`) and
  `StringError` (`std/string/string.yo:31`) — `std/allocator` and `std/string`
  sit BELOW `std/error` and `std/fmt`, which both import `std/string`. This is
  the same rule that gives `Utf8Error` inherent `message()`/`index()` instead of
  trait impls, and it is documented at
  `.github/instructions/yo-design.instructions.md:568-574`. The collection error
  enums (`ArrayListError`, `HashMapError`, `HashSetError`, `LinkedListError`)
  are in the same layer-below position.
- **Oversights, fix them**: `TlsError`, `DateTimeError`, `PercentError`.
  `std/crypto` and `std/time` are well above `std/error`; `std/encoding` already
  imports it (`std/encoding/error.yo:11-13` pulls in `Error` and `ToString`), so
  `std/encoding/percent.yo` — which today imports only `../string`,
  `../collections/array_list` and `./utf8` — has no layering excuse either.

## Fix

1. ~~`std/crypto/tls.yo`: add `impl(TlsError, Error());` at `:94`, between the
   `ToString` impl (`:80-93`) and `export(TlsError);`.~~ **DONE 2026-09-05.**
2. ~~`std/time/datetime.yo`: add `impl(DateTimeError, Error());` at `:306`,
   between the `ToString` impl (`:294-305`) and `export(DateTimeError);`.~~
   **DONE 2026-09-05** (with a new `{ Error } :: import("../error")`).
3. ~~`std/encoding/percent.yo`: add the missing `ToString` (human prose, matching
   the other std error enums — e.g. `truncated percent escape at byte N`,
   `invalid hex digit at byte N`, and for `InvalidUtf8(cause)` render the
   `Utf8Error` through its inherent `message()`/`index()`) and
   `impl(PercentError, Error());`, importing `{ Error }` from `../error` and
   `{ ToString }` from `../fmt/to_string.yo` the way `std/encoding/error.yo`
   does. Keep the imports NARROW — `std/error`'s blanket re-exports were
   deliberately narrowed on 2026-09-04 (`std/error.yo:1-7`).~~ **DONE
   2026-10-03**, via `derive(PercentError, Error(...))` rather than two
   hand-written impls — the idiom #514 migrated items 1-2 to
   (`.github/instructions/yo-design.instructions.md`: "Spell an error enum with
   `derive(Error)`, not two hand-written impls"); the imports stayed narrow
   (`{ Error } :: import("../error")` only).

Do NOT reach for a blanket `impl(generic(T : Type), where(T <: ToString), T,
Error())` as a shortcut: it compiles and would delete all ten explicit impls,
but it makes every `ToString` type (`i32`, `Path`, `Duration`, …) an error type,
which erases the deliberate marker D1 exists for — and would have hidden exactly
the two gaps recorded here.

Item 3 closed 2026-10-03. Items 1-2 were landed together with the `dyn()` bound check
(`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md`): that check turns
item 1 from a style violation into a build break, and this is the std half of the
same change.

## Regression test

`tests/crypto/tls.test.yo` and `tests/time/datetime.test.yo`: assert `Type.impls(TlsError, Error)` and
`Type.impls(DateTimeError, Error)` are `true`, plus a
`throw`/`downcast(err, TlsError)` round-trip through an `Exception` handler so
the dyn path is exercised. `tests/encoding/percent.test.yo`: the same for
`PercentError`, plus one `to_string()` text assertion per variant.

An audit-wide guard is worth considering separately: a test that walks the
declared `*Error` types and asserts `Type.impls(_, Error)` for every one above
the `std/error` layer.

## Breaking change

Additive only — new impls on existing types. Nothing that compiles today stops
compiling.

## Fixed

Item 3 (the open remainder): `PercentError` had neither a `ToString` nor an
`Error()` impl — it was the last of the three "oversights" the audit named, left
behind because nothing `dyn()`s one so the C69 bound check never reached it, and
unmigrated by #514's `derive(_, Error(...))` sweep. Fixed 2026-10-03 on branch
`s3/batch-3-fixes` by adding `derive(PercentError, Error(...))` to
`std/encoding/percent.yo` — one message per variant in declaration order
(`truncated percent escape at byte ${index}`, `invalid hex digit ${byte} at byte
${index}`, and `InvalidUtf8` rendered through its `Utf8Error` cause's inherent
`message()`/`index()`) plus the single narrow import `{ Error } ::
import("../error")`; `ToString` was already in scope. The derive supplies both
impls together, and its declaration-order check turns future variant drift into
a compile error. Regression test: `tests/encoding/percent.test.yo`'s
"PercentError impls Error and renders each variant" (`comptime_assert(Type.impls(PercentError,
Error))` plus one exact `to_string()` assertion per variant) — it failed before
the fix with `error: PercentError must impl Error` (0 of 9 tests ran) and passes
after (9/9); `yo check ./std` 178/178.
