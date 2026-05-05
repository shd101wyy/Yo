# Pattern matching: literal values in enum destructuring don't work as expected

## Status: DOCUMENTED LIMITATION — literal patterns (e.g. `.Some(true)`) are not supported; literals in destructure positions bind as variable names instead. Documented in `.github/skills/yo-syntax/syntax-cheatsheet.md`. Implementing real literal pattern matching is a future language feature, not a bug.

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

## Status

This is by design — Yo match patterns only support variable binding in enum variant destructuring, not literal matching. This should be documented as a common pitfall.

Cleanup of misleading uses:

- `yo-self/evaluator/trait_checking.yo` (commit pending) — collapsed
  `.Some(true) => ... .Some(false) => ...` (both arms identical, second
  was unreachable due to this language behavior) into `.Some(_) => ...`
  with a clarifying comment pointing back to this issue.

## Related

- Same issue would apply to `.IntLit(42)` — it would bind to variable named `42`, not match the literal
- Filter's `.BoolVal(keep)` pattern is correct because it uses a variable name and then checks with `cond`
