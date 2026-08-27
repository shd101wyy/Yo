# `json_parse` accepted every malformed number — and read any garbage as `0`

**Found**: 2026-08-27, by the C33 dead-variant audit (`JsonError.InvalidNumber`
was declared, documented and formatted, but nothing in the tree ever produced
it). **Fixed**: same day — `parse_number` now validates RFC 8259 section 6
before handing the span to `atof`. Pinned by three tests in
`tests/encoding/json.test.yo`.

## Symptom

`_Parser.parse_number` scanned an optional `-`, digits, an optional `.` +
digits and an optional exponent, then unconditionally returned
`.Ok(atof(span))`. It validated nothing, so every malformed form below parsed —
and two of them returned a plausible, silently WRONG value.

Worse: `_parse_value` routes every unrecognized leading byte to
`parse_number` (its `true =>` fallthrough arm). An empty span makes
`atof("")` return `0.0`, so **any non-empty garbage parsed as the number 0**:

```
$ ./json_number_repro        # before
bare minus "-":            ACCEPTED as Number 0
trailing dot "1.":         ACCEPTED as Number 1
empty exponent "1e":       ACCEPTED as Number 1
empty signed exponent "1e+": ACCEPTED as Number 1
leading zero "01":         ACCEPTED as Number 1
minus leading zero "-01":  ACCEPTED as Number -1
bare plus "+1":            ACCEPTED as Number 0
garbage "@":               ACCEPTED as Number 0
html "<html>":             ACCEPTED as Number 0
word "hello":              ACCEPTED as Number 0
empty "":                  rejected (unexpected end of input)
```

So `json_parse_result(body)` on an HTML error page — the classic "the API
returned a 502 page instead of JSON" case — yielded `Ok(Number(0))` rather than
an error. `src/lsp/server.yo:241` parses every incoming JSON-RPC frame through
this same entry point.

## Mechanism

`std/encoding/json.yo`'s number path had no grammar checks at all:

- no "at least one digit" requirement, so `-` and an empty span both passed;
- no `int = zero / ( digit1-9 *DIGIT )` rule, so `01` passed;
- no `frac = decimal-point 1*DIGIT` rule, so `1.` passed;
- no `exp = e [ minus / plus ] 1*DIGIT` rule, so `1e` and `1e+` passed;
- `atof` reports nothing — it returns `0.0` for input it cannot read, which is
  indistinguishable from a real `0`.

`JsonError.InvalidNumber` existed precisely for these cases and was never
constructed, which is what led the audit here.

## Fix

`parse_number` now walks the RFC 8259 grammar and returns
`.Err(.InvalidNumber)` at each violation: a required first digit (`0` or
`1`–`9`), a leading zero that may not be followed by a digit, a `.` that must be
followed by at least one digit, and an `e`/`E` (with optional sign) that must be
followed by at least one digit. The span is handed to `atof` only after it
validates, so `atof` can no longer be asked to read something it will silently
turn into `0.0`.

Verified after the fix — every malformed form above is `rejected (invalid
number)`, and `0`, `-0`, `42`, `-17`, `0.5`, `-1.5e3`, `1E+2`, `1e-2`, `0e0`,
`123456789` all still parse to the right values.

## Tests

`tests/encoding/json.test.yo` (56 pass, was 53):

- `json_parse rejects malformed numbers` — `-`, `1.`, `1e`, `1e+`, `1E-`, `01`,
  `-01`, `+1`, `.5`, `-.5`
- `json_parse rejects garbage instead of reading it as 0` — `@`, `hello`,
  `<html>`, `--1`
- `json_parse still accepts every valid number form` — the ten valid forms
  above (this one passed BEFORE the fix too, so it is a real baseline against
  over-rejection)

Both rejection tests were verified RED before the fix (`bare minus is not a
number` / `an unrecognized byte is not the number 0`).

## Not fixed here

`atof` honours `LC_NUMERIC`, so a program that calls `setlocale` with a
comma-decimal locale would read `1.5` as `1`. Yo programs do not call
`setlocale`, so the C locale applies and this is latent; a locale-independent
`strtod_l`/hand-rolled conversion is a separate change.
