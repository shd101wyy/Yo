# ArrayVal.set() — immutable semantics (NOT a bug)

## Summary

~~Calling `.set()` on an ArrayVal in the self-hosted evaluator causes a crash.~~

**RESOLVED**: `.set()` works correctly! It returns a **new** array with the element replaced.
The original sort tests crashed because they discarded the return value (causing infinite loops):

```rust
// WRONG — discards return value, array unchanged, loop never terminates
arr.set(i32(0), val);

// CORRECT — rebind to use updated array
arr = arr.set(i32(0), val);
```

## Verified working

```rust
arr := [i32(1), i32(2), i32(3)];
new_arr := arr.set(i32(1), i32(99));  // works!
// new_arr = [1, 99, 3], arr unchanged

// Swap pattern:
match(arr.get(usize(0)), .Some(a) => match(arr.get(usize(1)), .Some(b) => {
  arr = arr.set(i32(0), b);
  arr = arr.set(i32(1), a);
}, .None => ()), .None => ());
```

## Key points

- `.set(index, value)` returns a NEW ArrayVal (immutable operation)
- Index can be `i32(n)` or `usize(n)` — both work
- Must reassign: `arr = arr.set(...)` for mutation-like behavior
- Original sort test infinite-looped because array was never updated

## Location

`yo-self/evaluator/eval.yo` line 1798-1834
