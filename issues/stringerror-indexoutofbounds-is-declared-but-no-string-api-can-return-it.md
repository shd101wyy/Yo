# `StringError.IndexOutOfBounds` is declared and documented, but no `String` API can return it — bounds failures abort the process

**Found**: 2026-09-04, by the std-API-audit re-measurement of the dead-public-surface
row (a per-enum sweep of `std/`: 53 enums, 311 variants, with construction sites
scoped to the declaring module). **Status**: OPEN. Measured against `develop`
(`8d471c7df`) with `yo` 0.2.24 and `YO_STD=./std`.

**Class**: api-lie. Lower stakes than its two siblings in the same sweep
(`crypto-random-reports-every-failure-as-unavailable-and-discards-the-errno.md`,
`url-parse-validates-no-characters-so-a-crlf-url-splits-the-http-request.md`):
there is no missing safety check and no wrong value — the panic semantics are a
DECIDED design (D4). The defect is that a public enum publishes a *recoverable*
bounds error that no entry point offers, and the freeze would lock it in.

## Symptom

`std/string/string.yo:31-37`:

```rust
/// String operation error variants.
StringError :: enum(
  /// The input bytes are not valid UTF-8. `cause` says exactly what is wrong
  /// and at which byte offset.
  InvalidUtf8(cause : utf8.Utf8Error),
  /// The index is out of bounds for the string's byte length.
  IndexOutOfBounds(index : usize, length : usize)
);
```

The variant is real public surface — it is exported (`std/string/string.yo:2880`),
constructible and matchable — but the failure it documents aborts the process
instead of producing it:

```rust
open(import("std/string"));
{ println } :: import("std/fmt");

main :: (fn(io : Io) -> unit)({
  // The variant is public and matchable — it is real API surface.
  e := StringError.IndexOutOfBounds(index : usize(7), length : usize(3));
  println(match(e, .InvalidUtf8(_) => `utf8`, .IndexOutOfBounds(i, l) => `IndexOutOfBounds(${i}, ${l})`));
  // But no std API can ever hand it back. The documented bounds failure aborts:
  s := String.from("abc");
  println(`about to read byte 7 of a 3-byte string`);
  b := s.byte_at(usize(7));
  println(`unreachable: ${b}`);
});
export(main);
```

Observed, verbatim (the panic line is stderr, hence the interleaving), `rc=134`:

```
String.byte_at: index out of bounds (at file:///Users/yiyiwang/Workspace/Yo/std/string/string.yo:394:18)
IndexOutOfBounds(7, 3)
about to read byte 7 of a 3-byte string
```

Expected: either a `Result`-returning accessor that yields
`.Err(StringError.IndexOutOfBounds(index : 7, length : 3))`, or — the state the
codebase actually decided on — no such variant in the enum at all.

## Root cause

`grep -rn "IndexOutOfBounds" std/ src/ tests/ --include="*.yo"` finds nine hits.
Eight are `ArrayList` and `LinkedList`, where the same-named variant is genuinely
constructed (`std/collections/linked_list.yo:210, 226, 235, 266, 286, 295`;
`std/collections/array_list.yo:422, 424, 426`). The ninth is the `StringError`
declaration at `std/string/string.yo:36`. There is no construction site for the
string one anywhere.

Two independent causes let it survive:

1. **The design went the other way and the enum was not trimmed.** D4 (byte
   indexing, `plans/STD_API_AUDIT.md:243-283`) settled the boundary policy
   explicitly: "out-of-range CLAMPS; a non-boundary index PANICS in infallible
   `substring` (`try_substring` returns `.None`)". The non-panicking spellings that
   landed are `Option`-returning, not `Result`-returning —
   `try_substring : (fn(self : Self, start : usize, end : usize) -> Option(Self))`
   at `std/string/string.yo:1965`, alongside `floor_char_boundary` /
   `ceil_char_boundary` / `is_char_boundary` — so `StringError` was never going to
   be the channel. The bounds failures are `__yo_panic` calls:
   `std/string/string.yo:394` and `:396` ("String.byte_at: index out of bounds"),
   `:449` and `:452` ("String.substring: start/end is not on a UTF-8 character
   boundary"), and `:2824` ("String: index on empty string", the `Index(usize)`
   impl).

   The two functions that do return `Result(_, StringError)` cannot produce it
   either: `from_utf8` (`std/string/string.yo:90-96`) only ever builds
   `.InvalidUtf8(cause)` at `:94`, and `from_cstr` (`:118-131`) returns `.Ok` on
   every path.

2. **A plan note records the intention as though it were the implementation.**
   `plans/STD_API_AUDIT.md:676-680` reads "**`StringError` — WIRED UP, not
   deleted** (2026-08-25 correction) … `IndexOutOfBounds` is the natural error for
   D4 bounds failures." Only the `InvalidUtf8` half was ever wired. A reader
   checking the audit before the enum sweep would conclude the variant is live,
   which is how it passed the 2026-08-27 sweep.

There is a third, mechanical reason the earlier sweep missed it: that sweep counted
bare `.Variant` occurrences repo-wide, and `IndexOutOfBounds` scores nine hits
across three enums, so it looks alive until the count is scoped to the declaring
module. Any re-run of the dead-variant sweep must scope per-enum.

The one place the variant is named outside its declaration is a *negative*
assertion — `tests/encoding/utf8.test.yo:529` matches it only to fail:

```rust
.IndexOutOfBounds(_, _) => assert(false, "wrong StringError variant")
```

## Fix

Delete `IndexOutOfBounds` from `std/string/string.yo:35-36` (the doc comment and
the variant), leaving

```rust
/// String operation error variants.
StringError :: enum(
  /// The input bytes are not valid UTF-8. `cause` says exactly what is wrong
  /// and at which byte offset.
  InvalidUtf8(cause : utf8.Utf8Error)
);
```

and update the one dependent site, `tests/encoding/utf8.test.yo:520-531`: with the
enum single-variant, the `.IndexOutOfBounds(_, _) => assert(false, …)` arm at `:529`
names a variant that no longer exists and must be removed, leaving the
`.InvalidUtf8(cause)` arm as the whole match.

### Why delete rather than wire

The alternative — add `try_byte_at` / a checked `substring` returning
`Result(_, StringError)` — is not the right fix, for three reasons:

- D4 already chose the non-panicking spelling and it is `Option`, not `Result`
  (`try_substring`, `std/string/string.yo:1965`). Introducing a second, `Result`-shaped
  fallible convention for the same failure would split the contract.
- The information a `StringError.IndexOutOfBounds(index, length)` carries is
  exactly what the caller already had (`i` and `s.len()`), so the `Result` buys
  nothing over the `Option` that exists.
- Adding public API to give a dead variant a producer is the tail wagging the dog.
  Compare `CryptoError.Other`, where the diagnosis genuinely exists and is being
  thrown away — wiring is right *there* and wrong here.

If a checked byte accessor is wanted for its own sake, it is a separate additive
change (`try_byte_at(index) -> Option(u8)`, matching `try_substring`) and should
not resurrect this variant.

### Also fix the plan note

`plans/STD_API_AUDIT.md:678-679` must stop stating the intention as fact. Replace
"`IndexOutOfBounds` is the natural error for D4 bounds failures" with
"`IndexOutOfBounds` was never constructed — D4 chose panics plus `Option`-returning
`try_*` accessors — and is deleted." Leaving the sentence in place is what let the
variant survive one sweep already.

## Regression test

There is no positive assertion to add — the point of the fix is that a variant
ceases to exist — so the guard is structural:

- `tests/encoding/utf8.test.yo` — with the arm at `:529` removed, the remaining
  match on `String.from_utf8`'s error is exhaustive over a single-variant enum.
  That file **fails to compile** if the variant is ever re-added without a
  producer, which is the ratchet.
- `tests/string/string.test.yo` — add `StringError renders its only variant`,
  asserting that `String.from_utf8` on a truncated surrogate (`0xED 0xA0`) yields
  `.Err(.InvalidUtf8(cause))` with `cause.message() == "truncated UTF-8 sequence"`.
  This duplicates the utf8-file assertion deliberately: it pins `StringError`'s
  shape from the `std/string` side, which currently has no test naming the type.

Gates: `yo fmt std/string/string.yo`; `yo check ./std --std-path ./std`;
`yo test ./tests/encoding/utf8.test.yo --parallel 1`;
`yo test ./tests/string --parallel 1`; then the fast suite
`yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`, since
`std/string` is imported by essentially everything.

**No seed gate and no enum-collision risk.** Since C46 made enums nominal by
declared name under `require_exact`
(`issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md`,
regression test `tests/nominal_enum_identity.test.yo`), trimming `StringError` to
one variant cannot collide with `std/encoding/percent.yo:28`'s identically-shaped
`PercentError.InvalidUtf8(cause : utf8.Utf8Error)` — and `PercentError` has three
variants anyway.

## Breaking change

Yes. `StringError` is exported (`std/string/string.yo:2880`) and removing a public
variant breaks any exhaustive `match` on it in user code. It is free to do
**before** the API freeze and breaking after, so it belongs in the pre-freeze
deletion sweep (`plans/STD_API_AUDIT.md` §6) alongside the already-landed
`HashMapError.KeyNotFound` / `HashSetError.ElementNotFound` deletion (#374,
`11c34a8b6`). Release-note line: "`StringError.IndexOutOfBounds` is deleted; it was
never constructed — string bounds failures panic (D4) and the non-panicking
spellings return `Option`."
