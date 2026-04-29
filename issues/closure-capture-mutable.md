# Closures cannot capture mutable locals or globals

## Symptom

Code like:

```rust
caught := box(false);
given(exn) := Exception(throw: ((err) -> {
  caught.* = true;   // ❌ "use of undeclared identifier 'caught'" in C output
  escape ();
}));
```

fails C compilation with `use of undeclared identifier 'caught'`. The same
happens with a `(g_caught : bool) = false;` global at module scope — the
closure body cannot see it.

## Impact

Test code that uses Exception handlers cannot communicate the "I was called"
signal back to the test body without a side channel. For now we can only
test handlers via happy-path assertions inside the closure (`assert(false,
...)` to fail-fast on unexpected throws).

## Workaround

- For tests of error-throwing functions, install an `exn` whose `throw` does
  `assert(false, "unexpected error")` — the test fails noisily if the throw
  is taken.
- For tests of "did this throw?", currently no clean Yo-only solution.

## Affected

- `yo-self/tests/typeof.test.yo` had to drop its arity-error test. The
  arity check itself is identical to dozens of `exn.throw(...)` sites in
  `yo-self/parser/parser.yo`, which are exercised indirectly.

## Fix direction

Closure capture of mutable cells (Box, mutable globals) needs to work for
test ergonomics. Either:

1. Allow closures to capture `Box(T)` by value (the `.*` mutates the heap
   cell, not the closure's captured pointer).
2. Allow closures to read/write module-level mutable globals.

Either fix would unblock natural error-path testing in the bootstrap suite.
