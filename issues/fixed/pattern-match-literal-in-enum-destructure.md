# Pattern matching: literal values in enum destructuring don't work as expected

**Severity:** S1 (a silent wrong answer: the arm always matched)

**Status: FIXED.** A literal in a payload position first became a loud
rejection (match P0, #672, 2026-09-14 — the interim guard against exactly
this trap), then a real COMPARISON with the full pattern IR (match P1–P3,
#791, 2026-09-19): `.BoolVal(true)` matches only a true payload, at any
depth, for numbers, bools, chars and strings. Pinned by
`tests/match_nested.test.yo`, `tests/match_strings.test.yo` and the
`match-string-payload-accepted` cli-case; the design record is
`plans/reference/MATCH_PATTERN_MATCHING.md`. The limitation text below is
the historical record of the pre-2026-09 behavior.

## Problem

In Yo, match patterns like `.BoolVal(true)` do **not** match only when the inner value is `true`. Instead, the `true` is treated as a **variable binding** — it binds the inner bool to a new variable named `true` (which shadows the keyword). This means the arm **always matches** any BoolVal, regardless of the actual boolean value.

## Example

```rust
// ❌ WRONG — always matches any BoolVal (true OR false)
match(some_value,
  .BoolVal(true) => { handle_true_case(); },
  _ => ()
);

// ✅ CORRECT — bind to variable, then check with cond
match(some_value,
  .BoolVal(b) => cond(b => { handle_true_case(); }, true => ()),
  _ => ()
);
```

## Impact

This caused a bug in `yo-self/evaluator/eval.yo` where `ArrayVal.find()` returned the first element regardless of the predicate result (Phase 5al). The pattern `.BoolVal(true) => { found_fi = .Some(elem_fi); }` matched ALL BoolVals including `false`, so every element was considered a match.

## Workaround

Always use a variable binding and then check the value with `cond`:

```rust
.BoolVal(bval) => cond(bval => { ... }, true => ()),
```

## Status (historical)

This was recorded as by-design at the time — Yo match patterns only
supported variable binding in enum variant destructuring, not literal
matching. Real literal matching landed in 2026-09 (see the FIXED status
above), so the workaround below is no longer needed.

Cleanup of misleading uses:

- `yo-self/evaluator/trait_checking.yo` (commit pending) — collapsed
  `.Some(true) => ... .Some(false) => ...` (both arms identical, second
  was unreachable due to this language behavior) into `.Some(_) => ...`
  with a clarifying comment pointing back to this issue.

## Related

- `.IntLit(42)` had the same behavior — it bound to a variable named `42`;
  it compares since #791
- Filter's `.BoolVal(keep)` pattern was the correct pre-2026-09 spelling
  (a variable name, then `cond`); today `.BoolVal(true)` is the direct form
