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

✅ FIXED (2026-04-27).

The fix lives in two places:

- `src/evaluator/exprs/property-access.ts` — when the `.` operator's
  property is `*` and the object expression's metadata has an
  `indexTraitPtrType` (i.e. it came from an Index trait dispatch which
  already auto-dereferenced the pointer), and the Output type does not
  itself define a custom `*` member (e.g. `Box(T)` has `*` as an object
  field for unwrapping the inner value), treat the `.*` as a no-op:
  propagate the object's evaluation metadata to the parent expression.

- `src/codegen/exprs/property-access.ts` — in `generateFieldAccess`,
  apply the symmetric no-op so the C output emits just the receiver code
  (instead of `recv._u42_`, which would be a struct member lookup of the
  C-sanitized identifier for `*`).

Regression test:
`tests/collections/array_list.test.yo` — "ArrayList index with redundant
._ deref - issue arraylist-index-deref-pattern". Verified via `bun run
build && ./yo-cli test ./tests/collections/array_list.test.yo` (89/89
pass). The original Box-unwrap pattern `arr_of_boxes(idx)._`(which IS a
real Box`\*`field access, not a redundant deref) continues to work via
the`hasStarMember` guard.
