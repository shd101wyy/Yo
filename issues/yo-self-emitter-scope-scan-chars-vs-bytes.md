# yo-self: emitter block-scope scanner bounded by chars, indexed by bytes — phantom `{` sentinels (regex `undeclared m2`)

**Status: FIXED** (this commit). Flips `tests/regex/regex.test.yo`.

## Symptom

`tests/regex/regex.test.yo` under the s1 binary failed with C compile errors:
`use of undeclared identifier 'm2'` (6-7 sites), all inside
`if (__yo_effect_escaped) { // Drop local variables before early return ... }`
cleanup blocks of the SECOND test body — dropping `m2` before its C
declaration. Minimal pair: two `test()` bodies where body 1 asserts
`mX.unwrap().value() == <multibyte literal>` and body 2 reuses the names
`m1`/`m2` (`/tmp/re_j2.test.yo`).

Bisect matrix facts (all explained by the root below):

- ASCII-izing the literals → passes.
- Renaming test 2's variables to `a1`/`a2` → ALL multibyte variants pass
  (the bug needs a same-NAME pending drop in a later sibling block).
- Which variant visibly fails flip-flops with literal content/position —
  the phantom-sentinel drift depends on exact emitted line layouts.

## Root

`_emitter_track_scope` (emitter.yo) — the maintainer of `declared_scopes`,
the C block-scope stack used by the escape-path drop gate
(`_keep_pending_drop`'s `scope_stack_contains`, codegen/exprs/return.yo) —
bounded its scan with `line.len()` (**chars**) while indexing with
`line.byte_at(i)` (**bytes**). Any emitted C line containing raw multibyte
text (e.g. the compound-literal spill
`__yo_str __yo_ref_spill_N = (__yo_str){ .ptr = (const uint8_t*)"再见", .len = 6 };`)
was under-scanned by `bytes_len - len` bytes; the closing `}` (and/or the
literal's closing `"`) in the lost tail was missed. The line's `{` then
became a phantom open sentinel: the NEXT real `}` popped the phantom instead
of its own block, desyncing the stack for the rest of the function. Block 1's
named locals (`m2`) stayed "in C scope" after block 1 closed, so block 2's
mid-body escape checks — whose gate on the `skip_env_check=true` path relies
ONLY on `scope_stack_contains` (yo-self's recorded envs are END-of-scope, so
the token/env gates are unusable there) — emitted drops for the same-named
`m2` before block 2's declaration.

This is yo-self-ONLY machinery (TS has no scope stack; its per-expr
point-in-time persistent envs make it unnecessary), so there is no TS
behavior to mirror — the compensation layer itself was buggy.

Same chars-vs-bytes family as the String multibyte memory
(`String.len()` = chars; bytes via `bytes_len()`/`byte_at()`).

## Fix

`_emitter_track_scope`: bound the scan with `line.bytes_len()`. ASCII
structural bytes (`{ } " ' / \`) cannot occur inside UTF-8 continuation
sequences, so a plain byte scan is exact. The sibling helpers
(`_emitter_record_declared_temp`, `_emitter_record_scope_decl`) walk only the
pure-ASCII prefix before `" = "` (type/name position), where char and byte
indices coincide — left unchanged.

## Verification

- /tmp/re_j2.test.yo: 0 undeclared, both tests pass.
- tests/regex/regex.test.yo green under s1.
- Full battery: codegen-bootstrap diff-test, check ./std, 12-file spot set
  (+ encoding/json, encoding/utf16 — multibyte-heavy), STRICT_FIXPOINT — see
  commit.
