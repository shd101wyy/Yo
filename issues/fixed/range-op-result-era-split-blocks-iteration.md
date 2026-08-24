# `..`/`..=` operator results live in their own type era — Range(T) can never dispatch trait impls

**Status: FIXED (2026-08-24, branch `fix/range-op-era-split`).** Found
implementing S1 chunk 4 (plans/STD_API_AUDIT.md D3.5, Range iteration).
This was WHY "today ranges don't iterate": it was never just missing impls.

## Symptom

With `impl(Range(i32), Iterator(...))` registered (a per-type concrete impl):

```rust
r := Range(i32)(start : i32(0), end : i32(5));
r.next();                      // WORKS — direct construction dispatches

r2 := (i32(0)..i32(5));
r2.next();                     // FAILED — "No matching call found"
(i32(0)..i32(5)).count();      // FAILED — blanket methods too
for(i32(0)..i32(5), (i) => ...) // FAILED at the for macro's .into_iter()
```

Same for `usize` (the one type that could already form a range) and `..=`.
Minimal repro (no Iterator needed): a user trait implemented on
`Range(usize)` dispatches on a ctor-built receiver, and misses
(`[dispatch-miss] name=bump recv=struct_yo_id_23 raw=0 resolved=0`) on an
op-built one.

## Root cause (one level deeper than first recorded)

The operator dispatch stamps the call result with the impl method's
recorded return type. That type was produced at IMPL REGISTRATION by
`_substitute_self_in_method_ty` → `substitute()` rewriting the trait's
declared `Range(Self)` — and **`substitute()`'s Struct arm keeps the
original `id` and `constructor_func_id`** while rewriting the
type_arguments (src/types/substitution.yo). So the "concrete"
`Range(usize)` return is the TRAIT-DEFINITION era's abstract instance with
its args swapped — an instance the ctor memo never issued, that no
`impl(Range(usize), ...)` (which evaluates `Range(usize)` through the memo)
can ever be registered on. Worse, every concrete impl of the trait shares
that ONE id (ten integer RangeOp impls → ten distinct instantiations all
carrying the abstract instance's id).

The existing era repairs could not fire: the `rre_era_suspect`/`rte` repair
(calls/function.yo, calls/helper.yo) gates on the DECLARED return still
carrying SomeTs at call time — here the substitution happened at
registration, so by call time the recorded return is SomeT-free and
nothing looks suspect.

## Fix

Canonicalize the operator-dispatch result stamp through the CTFE ctor memo:

- `canonicalize_instantiation_via_ctfe_memo` (evaluator/calls/comptime_fn.yo):
  given a nominal struct instantiation with a known ctor fid and fully
  concrete type_arguments, look up the memo entry for the same
  (ctor, args) key and return its canonical instance; otherwise return the
  input unchanged. SomeT-carrying args are excluded (per-call closure
  families keep their capture identity), and the abstract memo entry
  (SomeT-keyed) can never match a concrete key.
- Applied to `resolved_ret` in the infix-operator dispatch arm of
  evaluator/calls/function.yo, right before the result ExprInfo stamp.

The memo entry always exists by call time: the impl method's own lambda
body (`(start, end) -> Range(usize)(start :, end :)`) routes through the
ctor memo during def-time evaluation at registration.

Verified: op-built `.next()`, blanket `.count()`/`.sum()`/`.filter()`, the
`for` macro over range literals, both `..` and `..=`, across all ten
integer types — tests/iterator_combinators.test.yo chunk-4 cases (32/32),
plus tests/{array,index,comptime,for_macro_borrow,flowability_comprehensive,string}
green (comptime ranges and slicing unaffected).

## Found en route (separate, still OPEN)

An Item-binding combinator (`min`) after `.map` at a SECOND Item type
adopts the FIRST call's Item — pre-existing, not range-specific:
issues/iterator-chain-shared-stamp-cross-item-pollution.md.
