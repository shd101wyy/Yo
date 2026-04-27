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

### Why the original `.*` is wrong

The Index trait's `index` method returns `*(Output)` and the call-site
desugaring is `value(arg) → Index(...).index(&value, arg).*` — the `.*`
is **already applied** as part of the desugaring. So `list(usize(0))`
evaluates to `String` (the `Output` type), not to `*(String)`. Writing
`list(usize(0)).*` then asks for a deref of a `String`, which has no
`*` member — that's a real user error, not a compiler bug.

The original failure mode was the cryptic
`Error: Expected to be evaluated.` thrown deep in the call dispatcher,
which made the type error completely unattributable.

### The fix

`src/evaluator/exprs/property-access.ts` now surfaces a clear error
when `.*` is applied to an expression that came from Index trait
dispatch (its metadata carries `indexTraitPtrType`) but the underlying
type does not define a `*` member:

> Cannot dereference value of type "String". The Index trait dispatch
> on this expression already returns the dereferenced element value
> (not a pointer), so the trailing "._" is redundant. Drop the "._"
> and chain the next call directly (e.g. `value(idx).method()`). If
> you intended to unwrap a smart pointer, the inner type "String"
> does not define a "\*" member.

The fall-through still works for legitimate `*` members — e.g.
`arr_of_boxes(0).*` continues to call `Box(T)`'s `(*) : V` field
because that lookup happens later in `property-access.ts`.

### Correct user code

```rust
list := ArrayList(String).new();
list.push(`hello`);
println(list(usize(0)).bytes_len().to_string());  // 5
```

Regression test: `tests/collections/array_list.test.yo` — "ArrayList
index .\* on non-pointer Output gives clear error - issue
arraylist-index-deref-pattern".
