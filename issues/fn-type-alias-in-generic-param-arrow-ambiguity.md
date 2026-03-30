# Bug: Chained function call on `.unwrap()` result confuses evaluator with fn-type-containing generics

## Description

When a function has a parameter of type `*(ArrayList(FnType))` where `FnType` is a function type alias, and the body calls `.unwrap()(...args...)` in a chained manner (getting a value from the list and immediately calling it), the evaluator confuses the `-> ReturnType` of the outer function with the function type alias inside the generic parameter.

## Minimal Reproduction

```rust
{ ArrayList } :: import "std/collections/array_list";

MyStruct :: struct(x: i32);

BlockRuleFn :: (fn(state: *(MyStruct), a: i32, b: i32, c: bool) -> bool);
RuleList :: ArrayList(BlockRuleFn);

// FAILS: "Cannot unify: Expected 'BlockRuleFn', Given: 'bool'"
test :: (fn(state: *(MyStruct), a: i32, b: i32, c: bool, rules: *(RuleList)) -> bool)({
  return rules.*.get(usize(0)).unwrap()(state, a, b, c);
});
```

## Workaround

Split the chained call into two steps — get the function value first, then call it:

```rust
// WORKS: separate .unwrap() result into a variable
test :: (fn(state: *(MyStruct), a: i32, b: i32, c: bool, rules: *(RuleList)) -> bool)({
  (f : BlockRuleFn) = rules.*.get(usize(0)).unwrap();
  return f(state, a, b, c);
});
```

## What works vs what fails

| Pattern                                                     | Status   |
| ----------------------------------------------------------- | -------- |
| `rules.*.get(i).unwrap()(args)` — chained call              | ❌ FAILS |
| `(f : Fn) = rules.*.get(i).unwrap(); f(args)` — two steps   | ✅ WORKS |
| Same fn signature with `return true;` body (no list access) | ✅ WORKS |
| `ArrayList(FnType)` as param without calling retrieved fns  | ✅ WORKS |

## Impact

Affects any function that retrieves a function value from a generic container and calls it inline. Common pattern in the markdown-it port where terminator rule lists (`ArrayList(BlockRuleFn)`) are iterated and called.

## Root cause (hypothesis)

The evaluator appears to process `rules.*.get(usize(0)).unwrap()(state, a, b, c)` incorrectly — when resolving the return type of the chained method calls, the `-> bool` from `BlockRuleFn`'s definition (or the outer fn's return type) leaks into the unification context of the generic type parameter, causing a "Cannot unify: Expected 'BlockRuleFn', Given: 'bool'" error.
