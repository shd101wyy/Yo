# ArrayList index-then-deref pattern limitation

## Summary

`toks(usize(N)).*.field` — using the explicit `.*` dereference on an `ArrayList` index
result — fails with "Expected to be evaluated." in the Yo evaluator.

## Reproduction

```rust
list := ArrayList(String).new();
list.push(`hello`);
// WRONG — .*  fails: "Expected to be evaluated."
println(list(usize(0)).*.bytes_len().to_string());

// CORRECT — typed extraction via .get()
match(list.get(usize(0)),
  .Some(s) => println(s.bytes_len().to_string()),
  .None => ()
);
```

## Affected version

`bootstrap/phase-1` branch (observed during Phase 1 lexer port).

## Root cause

`ArrayList.index(usize)` returns `*(T)` (a pointer to the internal element).
The evaluator's property-access path for `.(*, receiver)` (the `.*` operator)
requires `receiver.$.type` to be set. When the receiver is the result of an
Index trait dispatch, the type is not always propagated correctly, causing
`receiverArg.$.type` to be `undefined` and triggering the
"Expected to be evaluated." error.

## Workaround / correct pattern

1. **Use `.get(i)` and `match/unwrap`** (preferred — returns `Option(T)` by value):

   ```rust
   match(list.get(usize(0)), .Some(v) => { /* use v */ }, .None => ())
   ```

2. **Use typed left-hand assignment** (triggers implicit deref):
   ```rust
   (s : String) = list(usize(0));
   ```
   The explicit type annotation causes the evaluator to auto-deref the `*(T)` result.

## Status

Known limitation — workarounds above are sufficient for bootstrap Phase 1.
A proper fix would require propagating the type through Index trait dispatch
in the evaluator's property-access handler.
