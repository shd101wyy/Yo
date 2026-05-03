# ArrayVal.set() crashes in self-hosted evaluator

## Summary

Calling `.set()` on an ArrayVal in the self-hosted evaluator causes a WASM trap/crash
(exit code 134 = SIGABRT) rather than returning a new array.

## Reproduction

```rust
arr := [i32(1), i32(2), i32(3)];
arr.set(usize(0), i32(99));  // CRASH
arr.set(i32(0), i32(99));    // CRASH
```

## Expected behavior

`.set(idx, val)` should return a new ArrayVal with the element at `idx` replaced by `val`.

## Impact

- Cannot implement in-place-style sorting algorithms (selection sort, bubble sort)
- `.set()` method exists at `yo-self/evaluator/eval.yo:1798` but crashes at runtime

## Workaround

Use immutable patterns: build new arrays with `.map()` or `.filter()` instead of
in-place mutation via `.set()`.

## Location

`yo-self/evaluator/eval.yo` line 1798-1830
