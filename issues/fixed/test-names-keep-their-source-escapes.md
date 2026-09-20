# `yo test` prints a test name with its source escapes intact

**Status: fixed 2026-09-20** (the `yo test --list` / `--json` PR).

## Symptom

```rust
test("beta: a \"quoted\" second name", { assert(true); });
```

`yo test` printed `✓ beta: a \"quoted\" second name` — backslashes included —
and `--json` then escaped the backslashes again (`\\\"`), so the name a
consumer read back was not the name in the source.

## Root cause

`extract_test_name` (`src/main.yo`) read the `StringLit` token's RAW value and
only stripped the surrounding quotes. The comment on its call site claimed it
"reads the EVALUATED comptime string and only falls back to the raw token
value", but the runner collects names from the parsed AST before anything is
evaluated, so the fallback was the only path.

## Fix

Decode with the evaluator's own `decode_str_lit_escapes` (the table
`evaluate_string_literal` uses), then strip the quotes the decoder keeps.

## Gate

`tests/cli-cases/test-list` lists a test whose name carries a `\"` escape; the
golden shows the decoded quote in both the plain and the `--json` form.
