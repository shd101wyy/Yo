# yo-self codegen: rune-counted bounds on byte-indexed scans truncated emitted C (multibyte strings)

## Symptom

Any emitted C containing a multibyte string literal could be corrupted.
Minimal repro (was rc=139 under s1; TS fine):

```rust
main :: (fn() -> unit)({
  assert(true, "absent name → None");
});
```

Emitted: `... .len = 20));` — the compound literal's closing ` }` missing →
`error: expected '}'` → whole batch C fails (the yo-self/tests env_lookup /
env_find_variable_frame_level / expr_traversal batch family, and part of the
collections family).

## Root cause

`String.len()` counts RUNES (skips UTF-8 continuation bytes); `byte_at` is
byte-indexed; `substring`/`index_of` are rune-indexed. Multiple codegen
scanners walked `while(i < s.len())` reading `byte_at(i)` — under-walking
multibyte content by exactly `bytes − runes` bytes, truncating the tail of
the scanned/rebuilt fragment. `_split_top_level_args_list`
(exprs/other_fn_call.yo) was the output-corrupting one (it REBUILDS the arg
list byte-by-byte); the word-return scanners (exprs/cond.yo, exprs/match.yo)
additionally fed RUNE indices from `index_of` to `byte_at`.

## Fix (all sites audited via `grep -rn byte_at yo-self/codegen`)

- `_split_top_level_args_list`, `_scan_ident`, `_match_bracket`,
  `_is_addressable_c_expr` (+ new `_byte_slice`) — exprs/other_fn_call.yo
- `_contains_word_return` + new `_byte_index_of` — exprs/cond.yo,
  exprs/match.yo
- `sanitize_for_c_identifier` — utils/index.yo
- `_all_digits` — exprs/init_assignment.yo, exprs/property_access.yo
- `_is_valid_yo_identifier` — functions/collection.yo
- (begin.yo's marker scan reads sanitize output — ASCII by construction —
  left as-is.)

Cheatsheet updated (.github/skills/yo-syntax/syntax-cheatsheet.md) with the
rune/byte rules.

## Test

`/tmp/mb_repro.yo` (the assert above) compiles and runs under s1.
Regression case added to tests/ as part of this fix's commit.
