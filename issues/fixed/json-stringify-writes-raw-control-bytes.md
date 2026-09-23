# `json.stringify` wrote control bytes raw, producing invalid JSON

**Status: FIXED** (2026-09-23; found auditing `yo context`'s JSON output,
`plans/YO_CONTEXT.md` C7).

## Symptom

`_write_str_escaped` (`std/encoding/json.yo`) escaped `"`, `\`, `\n`, `\t` and
`\r` and copied every other byte through. RFC 8259 §7 requires ALL of
U+0000-U+001F escaped inside a string, so a string holding, say, U+0001 or a
form feed stringified to bytes no conforming parser accepts. Measured with a
tree-built binary: `json.stringify(JsonValue.Str(<0x01 0x08 0x0C>))` was the
5 bytes `"<0x01><0x08><0x0C>"`. std's own `parse_string` accepted it only
because of its separately documented leniency
(`issues/stddoc-io-json-parse-string-accepts-raw-control-bytes.md`), which
hid the defect from every round-trip test.

## Fix

`\b` and `\f` get their short escapes; every other control byte is written as
`\u00XX` (lowercase hex, as `serde_json` does).

## Test

`tests/encoding/json.test.yo` — "json.stringify escapes every control byte":
U+0001, U+0008, U+000C, U+001F and U+0000 stringify to escapes, the output
holds no byte below 0x20, and it parses back to the same string. Fails before
the fix.
