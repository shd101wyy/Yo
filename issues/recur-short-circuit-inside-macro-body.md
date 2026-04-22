# Issue: `recur` short-circuits inside macro bodies during caller validation

## Status

RESOLVED — fixed in `src/evaluator/calls/function.ts` (macro-expansion call sites now clear `isValidatingFunctionDefinition` / `isAnalyzingCtfeCapability` and set `isExecuting: true`).

## Background

This issue was originally filed as "`unquote_splicing` fails during macro body validation". Investigation showed:

1. The original repro used invalid syntax `...(unquote_splicing(elems))` (double-wrap). Only `unquote_splicing(elems)` and `...(unquote(elems))` are recognized in `quote.ts`.
2. **However**, while implementing the §1.8 collection literal macros (`array_list`, `hash_map`, `hash_set`), a real bug surfaced: `recur` in a comptime helper that builds an `ExprList`, when called from inside a macro body, returns `UnknownValue` — causing the splice to be skipped and arg-count validation to fail.

## Real root cause

`src/evaluator/exprs/recur.ts` short-circuits to `UnknownValue` when either `context.isAnalyzingCtfeCapability` or `context.isValidatingFunctionDefinition` is set.

Macro expansion happens **inside the caller's evaluation context**. When a function (e.g. `main`) is being validated, the validation flag stays set through the entire body — including macro calls. The macro body therefore runs with concrete arguments, but `recur` inside any helper it invokes still short-circuits, breaking helpers that build `ExprList` recursively.

## Fix

`src/evaluator/calls/function.ts` (two macro-call sites at the `forMacroExpansion` and the `functionType.return.isUnquote` branches) now overrides the context for the duration of the macro body evaluation:

```ts
context: {
  ...context,
  isValidatingFunctionDefinition: false,
  isAnalyzingCtfeCapability: false,
  isExecuting: true,
}
```

This is correct because macro expansion **must** fully evaluate its body — its return value is the expanded code that subsequent validation depends on.

## Verification

- `tests/collection_literals.test.yo` — 11 tests, exercise `array_list`, `hash_map`, `hash_set` literals (empty, single, multi, nested, RC types).
- Regression: `tests/collections/{array_list,hash_map,hash_set}.test.yo`, `try_macro`, `comptime`, `derive`, `algebraic_effects`, `iterator_combinators`, `fmt` — all green.
