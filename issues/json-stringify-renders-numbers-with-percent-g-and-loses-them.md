# `json_stringify` renders every number through `%g` — `123456789` serialises to `1.23457e+08` and parses back as `123457000`

**Status:** OPEN — wrong value on a shipped serializer; JSON output is not a
round-trip. Found 2026-09-04 in the std-API-audit re-measurement of the
encoding/TOML row, while deciding how a future TOML writer should render
floats.

## Symptom

`json_stringify(.Number(n))` formats `n` with C's `%g`, whose default precision
is **6 significant digits**. The result is still valid JSON, so nothing errors —
it just denotes a different number.

```rust
{ json_parse_result, json_stringify, JsonValue } :: import("std/encoding/json");
open(import("std/string"));
open(import("std/fmt"));

rt :: (fn(n : f64) -> unit)({
  s := json_stringify(JsonValue.Number(n));
  back := json_parse_result(s);
  (got : f64) = f64(0);
  match(
    back,
    .Ok(v) => {
      match(v, .Number(x) => { got = x; }, _ => ());
    },
    .Err(e) => ()
  );
  (gi : i64) = i64(got);
  (ni : i64) = i64(n);
  nis := ni.to_string();
  gis := gi.to_string();
  println(`in=${nis} text=${s} out=${gis}`);
});

main :: (fn() -> unit)({
  rt(f64(123456789));
  rt(f64(1234567));
  rt(f64(2147483647));
});
export(main);
```

Observed (`yo` v0.2.24, `--std-path ./std --optimize 2`):

```
in=123456789 text=1.23457e+08 out=123457000
in=1234567 text=1.23457e+06 out=1234570
in=2147483647 text=2.14748e+09 out=2147480000
```

Expected: `text` = `123456789` / `1234567` / `2147483647` and `out` == `in`.
Every integer up to 2^53 is exactly representable in an `f64` and must survive a
`stringify` → `parse` round trip; `i32.MAX` coming back as `2147480000` is a
silently corrupted value, not a shortened rendering.

The same happens to fractions — `json_stringify(.Number(pi))` is `3.14159`, and
comparing the re-parsed value against the original answers "not equal".

## Root cause

One `snprintf` format string, in the `.Number(n)` arm of the stringify walker:

```rust
// std/encoding/json.yo:874
unsafe(snprintf(*(char)(buf_ptr), usize(32), "%g", n));
```

`%g` without a precision means `%.6g`. There is no round-trip check anywhere on
the path.

The identical defect sits in the `ToString` impls that a hand-written writer
would reach for instead:

```rust
// std/fmt/to_string.yo:118-123 (f32) and :127-131 (f64)
_snprintf_to_string("%g", f64, self)
```

so `f64(123456789).to_string()` is also `1.23457e+08`, and `${x}` prints pi as
`3.14159`.

Note this is NOT the same bug as
`issues/fixed/float-literals-normalized-through-6-digit-percent-g.md`, which
fixed the **compiler's** internal float-literal carrier (now `%.17g` via
`f64_raw_roundtrip` in `src/evaluator/utils.yo`). That doc explicitly left std's
display path on `%g`: *"Display formatting (`println`, `${x}`) is untouched: it
still goes through std's `%g` `ToString`"*. This is that untouched half, plus
the serializer that should never have shared it.

## Fix

Add one shortest-round-trip renderer to `std/fmt` and use it from both places:

```rust
/// Shortest decimal rendering of `v` that parses back to exactly `v`.
_f64_shortest :: (fn(v : f64) -> String)({ … })
```

Try `%.15g`, then `%.16g`, then `%.17g`, and take the first whose
`String.parse_f64()` compares equal to `v` (`%.17g` always round-trips an IEEE
double, so the loop always terminates). This is what Rust, Go and Python print
by default, and it keeps `0.1` as `0.1` instead of `%.17g`'s
`0.10000000000000001`. `std/fmt/to_string.yo` already imports `../string`
(`:3`), so `parse_f64` is reachable with no new module cycle — but note it is
broken today for 3- and 8-byte significands
(`issues/parse-f64-rejects-every-3-or-8-byte-significand.md`), so **that fix
lands first** or the round-trip check rejects its own correct output.

Then:

1. `std/encoding/json.yo:871-880` — build the number text with the helper
   instead of the inline `snprintf`. The existing 32-byte buffer is still
   enough (`%.17g` needs at most 25 bytes including the NUL), but the helper
   should own the buffer.
2. `std/fmt/to_string.yo:118-131` — `f64` and `f32` `ToString` use the helper
   (f32 via `f64(self)`, matching the current widening, or a `%.9g`-based
   shortest for `f32`).

**Design choice in step 2.** Option (a): fix only `json_stringify`, leaving
display on `%g`. Option (b): fix both. Recommend **(b)**: `to_string()` claiming
to render an `f64` while destroying it below 6 significant digits is the same
API lie one level down, it is what a TOML/CSV writer will grab next, and Yo
already offers `${x:.2}` (`std/fmt/writer.yo:92-96`) for callers who want a
fixed display precision. Verified available today: `${x:.2}` → `3.14`,
`${x:.15}` → `3.141592653589793`.

## Regression test

`tests/encoding/json.test.yo` — a new `json_stringify round-trips numbers` test
asserting `json_parse_result(json_stringify(.Number(n)))` equals `n` for
`123456789`, `1234567`, `2147483647`, `9007199254740992` (2^53), `0.1`,
`f64(3.141592653589793)`, and the exact TEXT for the integer cases
(`"123456789"`, not `"1.23457e+08"`). The existing `json_stringify number` test
(`:403-406`) uses `42`, which passes either way, so it is not a baseline.

If the `ToString` half is taken, `tests/fmt` (or `tests/string/string.test.yo`'s
to_string coverage) needs the same pinning: `f64(123456789).to_string() ==
"123456789"` and `f64(3.141592653589793).to_string() == "3.141592653589793"`.

## Breaking change

Yes, for step 2: any program printing a float with `${x}` or `.to_string()` sees
more digits than before (`3.14159` → `3.141592653589793`), and any golden file
or test comparing such output changes. Call it out in the release notes.
`json_stringify`'s change (step 1) is a bug fix — the old output denotes the
wrong number.
