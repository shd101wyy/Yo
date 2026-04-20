# Issue: `unquote_splicing` fails during macro body validation

## Status

OPEN — discovered during bootstrapping prerequisites work for §1.8 collection literal macros.

## Repro

```rust
sum_all :: (fn(a : i32, b : i32, c : i32) -> i32)((a + (b + c)));

ints_sum :: (fn(...(quote(elems))) -> unquote(Expr)) {
  quote {
    sum_all(...(unquote_splicing(elems)))
  }
};

main :: (fn() -> unit) {
  total := ints_sum(i32(10), i32(20), i32(30));
  ()
};
```

## Error

```
Error: Too few arguments for function call:
Expected: 3 arguments
Got:   1 arguments

    sum_all(...(unquote_splicing(elems)))
```

The body validation phase tries to type-check `sum_all(splice)` _before_ the
macro is expanded. During that validation, `elems` has `UnknownValue`, so
`processUnquotesInExpr` (in `src/evaluator/builtins/quote.ts`, ~line 134-145)
falls through to keeping the `unquote_splicing(elems)` arg as-is, producing
`sum_all(unquote_splicing(elems))` — one argument, not three — which fails arg
count check.

## Root cause

`processUnquotesInExpr` checks `isExprListType(evaluatedUnquoteSplicingArg.$.type)`.
During body validation when the argument has `UnknownValue`, the type may not
yet be resolved as `ExprList`, so it can't expand. The variadic macro
`...(quote(elems))` correctly types `elems` as `ExprList` per
`src/evaluator/types/function.ts:2150`, but inside the quote body during
validation, the type info isn't available the same way.

## Workaround

Splice into other contexts (begin blocks, custom macros that don't validate
arg count statically) or implement collection literals as TS builtins.

## Impact

Blocks pure-Yo implementation of variadic collection literal macros
(`array_list`, `hash_map`, `hash_set` from §1.8 of
`plans/BOOTSTRAPPING_PREREQUISITES.md`). Workaround: implement these as
builtin macros in `src/evaluator/builtins/` (estimated 200-400 lines).

## Suggested fix

Either:

1. Skip arg count validation when a function call's args contain
   `unquote_splicing`/`spread` of an UnknownValue ExprList — defer to
   post-expansion.
2. During body validation, treat the result of `unquote_splicing(elems)`
   where `elems : ExprList` as a "splice marker" that satisfies any arg count
   check.
