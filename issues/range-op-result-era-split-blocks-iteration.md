# `..`/`..=` operator results live in their own type era — Range(T) can never dispatch trait impls

**Status: OPEN.** Found 2026-08-24 implementing S1 chunk 4
(plans/STD_API_AUDIT.md D3.5, Range iteration) on branch `s1-range` (WIP,
not pushed). This is WHY "today ranges don't iterate": it was never just
missing impls.

## Symptom

With `impl(Range(i32), Iterator(...))` registered (a per-type concrete impl):

```rust
r := Range(i32)(start : i32(0), end : i32(5));
r.next();                      // WORKS — direct construction dispatches

r2 := (i32(0)..i32(5));
r2.next();                     // FAILS — "No matching call found"
(i32(0)..i32(5)).count();      // FAILS — blanket methods too
for(i32(0)..i32(5), (i) => ...) // FAILS at the for macro's .into_iter()
```

Same for `usize` (the one type that could already form a range) and `..=`.

## Root cause (probe: YO_DEBUG_DISPATCH)

The operator-built receiver arrives as `struct_yo_id_23` — an EARLY-era
`Range(i32)` instance minted when the `RangeOp` trait's declared return
`Range(Self)` was substituted, DISTINCT from the ctor-memo instance the
`impl(Range(i32), Iterator(...))` registered on. Every generic candidate
then fails "Cannot unify incompatible struct types", and the concrete
registry lookup misses on the id.

This is the recursive-instantiation-identity class
(issues/fixed/yo-self-unsubstituted-type-param-emits-duplicate-struct.md):
`calls/function.yo`'s `rre_era_suspect` re-evaluation repairs exactly this
for `fn(forall(V), ...) -> Box(V)` returns by routing the declared-return
EXPRESSION through the ctor memo — but the TRAIT-OPERATOR path
(`(..) : fn(start : Self, end : Self) -> Range(Self)`, Self-substitution
rather than forall-substitution) appears to bypass that repair.

## Fix direction

Make the trait-op return-type resolution route `Range(Self)` through the
same era repair (re-evaluate the declared return expression in the callee
env with Self bound), or canonicalize the op impl's stamped result through
the ctor memo. Verify with: op-built `.next()`, blanket `.count()`, and the
`for` macro over a range literal, for BOTH `..` and `..=`, across all ten
integer types.

## Parked work (branch s1-range)

The std side of D3.5 is complete and checks clean: `RangeOp`/
`RangeInclusiveOp` impls for all ten integer types, `Iterator` impls for
`Range(T)`/`RangeInclusive(T)` (inclusive uses a wrap-safe canonical-empty
flip so `start..=T.MAX` terminates), plus tests in
tests/iterator_combinators.test.yo. It is blocked ONLY on this identity
split — the direct-construction repro proves the impls themselves are
correct.
