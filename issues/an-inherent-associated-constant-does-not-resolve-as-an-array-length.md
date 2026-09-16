# An INHERENT associated constant does not resolve as an `Array` length

**Status:** OPEN. Found 2026-09-16 while preparing the `std/` adoption that
value substitution (#714) exists to unblock. It is a LIMITATION of that
feature, not a regression — the case errors cleanly and never miscompiles.

## The asymmetry

A bare associated-constant projection resolves as an `Array` length when the
constant is declared as a TRAIT member, and does not when it is declared
INHERENTLY. Measured on a tree build of #714:

| declaration | `-> Array(u8, T.BYTES)` |
| --- | --- |
| `_W :: trait(BYTES : usize)` + `impl(u8, _W(BYTES : usize(1)))` | **works** |
| `impl(u8, BYTES : usize(1))` | **fails** — "Failed to evaluate the length expression: (T.BYTES)" |

The trait form also works when a width comes from a target-dependent
expression rather than a literal — `impl(usize, _W(BYTES : _CD))` with
`_CD :: cond((usize.MAX == usize(4294967295)) => usize(4), true => usize(8))`
resolves to 8 on a 64-bit box. That is the `usize`/`isize` case, and it is
NOT a problem.

## Why it matters — it is the shape `std/` would use

`BITS` is declared inherently in `std/prelude.yo`:

```rust
impl(
  i8,
  MIN : i8(-(128)),
  MAX : i8(127),
  BITS : u32(8)
);
```

`BYTES` beside it would be written the same way, and would not resolve. So the
byte-conversion row this feature exists to unblock cannot be written in the
obvious shape. **Step 3 of `plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`
should declare `BYTES` as a trait member**, which is verified to work; that is
recorded there too.

## The value is reachable — it is the READER that misses it

An inherent constant is fine in a VALUE position, including through a generic
blanket impl, which is how `std/prelude.yo`'s shift methods already use `BITS`:

```rust
impl(u8, BYTES : usize(1));
impl(generic(T : Type), T, wide : (fn(self : T) -> usize)(T.BYTES));
// prints "1 1 8" for `${u8.BYTES} ${u8(1).wide()} ${u8.BITS}`
```

So the constant is registered and readable. What fails is specifically
`find_associated_const_usize` (`src/evaluator/values/type_trait_methods.yo`),
the reader substitution calls, which scans
`get_type_trait_methods_for_type(tid)` and finds nothing at the moment it asks.

## A diagnosis that was TESTED AND REFUTED

The obvious story is lazy binding: inherent members are registered by the
lazily-forced phase-A path (`src/evaluator/values/impl.yo:3255`), trait-impl
fields eagerly, so a reader that scans without forcing misses them.

That was implemented — a force hook on the reader, installed with the same
`force_in_flight_field` that `env.yo` uses via `set_force_in_flight_field_fn`,
scanning again after a forced miss. **It changed nothing.** The build was green
(`check ./src` 275/275, `check ./std` 175/175, `tests/array.test.yo` 22 passed,
both existing rejections still rejecting) and the inherent case still failed.

The reason is visible in the forcer itself:

```rust
force_in_flight_field :: (fn(type_id : String, method_name : String) -> bool)({
  rec := match(newest_impl_in_flight_for(type_id), .Some(r) => r, .None => { return(false); });
```

It forces a field of an impl that is currently IN FLIGHT. A module-level
`impl(u8, BYTES : usize(1))` is not in flight when substitution asks, so the
hook returns false and the retry never happens. The change was reverted rather
than shipped, because a hook that provably cannot fire is worse than a
documented limitation.

So the timing story may still be right in outline, but `force_in_flight_field`
is not the mechanism that would fix it — a PENDING top-level binding forcer
would be (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), and finding the right
entry point is where the next attempt should start.

## What a fix has to preserve

Whatever forces, the two existing rejections must keep rejecting: a computed
length (`T.BYTES * 2`) and a projection whose receiver carries no such constant
(`T.NOPE`). Adding forcing to a reader is exactly the kind of change that can
turn a correct error into a wrong success, so both are pinned in
`tests/array.test.yo` and both were re-checked against the reverted attempt.
