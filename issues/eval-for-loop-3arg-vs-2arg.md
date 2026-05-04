# Self-hosted evaluator: built-in `for` handler diverges from TypeScript implementation

## Status: Bug — divergence from reference (TypeScript) implementation

## Description

The Yo `for` loop is a **prelude macro** defined in `std/prelude.yo` (line 5772). It takes
2 arguments and expands to `while runtime(true), { match(iter.next(), .Some(x) => body, .None => break) }`:

```rust
for(iter_expr, x => { body });          // expands at compile-time via prelude macro
for(list.iter(), x => { use(x); });     // first arg must have .next() method
```

### TypeScript reference behavior

The TypeScript evaluator (`src/evaluator/`) has **no built-in handler** for `for`. A grep
for `"for"` in `src/evaluator/` only finds the loop-context tracker `kind: "while" | "for"`
in `context.ts` — never any dispatch case. `for` is handled exclusively through the
generic macro-call path (because `prelude.yo` is auto-loaded into every module).

### Self-hosted evaluator divergence

`yo-self/evaluator/eval.yo` line 4682 contains a built-in handler:

```rust
(fval == "for") => match(args.get(usize(0)), ...)  // expects 3 args!
```

This handler:

1. Doesn't exist in the TypeScript reference
2. Expects the wrong arity — 3 args `for(item_pat, collection_expr, body_expr)` instead of
   the macro's 2 args `for(iter, x => body)`
3. Iterates only over `ArrayVal` values, not generic iterators with `.next()`

## Impact

- Self-hosted eval tests that use the proper 2-arg form crash with WASM unreachable.
- The 30+ existing eval tests in `yo-self/tests/eval.test.yo` use the wrong `for(x, arr, body)`
  3-arg form to work around this.
- Once the bug is fixed (built-in handler removed and prelude macro expansion supported),
  all those tests will need to be migrated to `for(arr.iter(), x => body)`.

## Fix Plan

1. Make `evaluate_module_body` (or its caller) load the prelude before evaluating test source,
   so the `for` macro is in scope and can be expanded via the normal macro-call path.
2. Remove the built-in `(fval == "for")` handler from `yo-self/evaluator/eval.yo`.
3. Migrate the existing 30+ eval tests from `for(x, arr, body)` to `for(arr.iter(), x => body)`.
4. Verify all yo-self/tests/eval.test.yo tests still pass.

## Workaround (temporary)

Until fixed, evaluator test source strings continue using the 3-arg form `for(x, arr, body)`
to match the buggy built-in handler. New tests should also use this form, with a comment
referencing this issue.
