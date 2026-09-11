# An associated constant used as an `Array` length resolves to 0 in the signature

**Status:** OPEN. Found 2026-09-10 while checking whether `to_be_bytes` could
become a blanket impl.

## Symptom

A blanket impl whose RETURN TYPE mentions an associated constant in an
`Array` length position emits a function whose C result type has length **0**,
while the specialized bodies correctly emit lengths 1 and 4:

```
/tmp/pl.c:1787:10: error: returning 'Array_uint8_t_1' from a function with incompatible result type 'Array_uint8_t_0'
 1787 |   return (Array_uint8_t_1){ .data = { 0 } };
/tmp/pl.c:1790:10: error: returning 'Array_uint8_t_4' from a function with incompatible result type 'Array_uint8_t_0'
 1790 |   return (Array_uint8_t_4){ .data = { 0, 0, 0, 0 } };
```

## Reproducer

`issues/repros/associated-constant-as-an-array-length-in-a-return-type.yo`:

```rust
Widthy :: trait(BYTES : usize);
impl(u8, Widthy(BYTES : usize(1)));
impl(u32, Widthy(BYTES : usize(4)));

impl(
  generic(T : Type),
  where(T <: Widthy),
  T,
  zeros : (fn(self : T) -> Array(u8, T.BYTES))(Array(u8, T.BYTES).fill(u8(0)))
);
```

The BODY's `Array(u8, T.BYTES)` substitutes correctly (1 and 4). The
SIGNATURE's does not — it resolves to 0.

## What works, for contrast

Both halves of this work independently, which is what makes the gap specific:

- **An associated TYPE in a return position**, supplied per-type and consumed
  from a blanket impl, works — including as a constructor:
  ```rust
  Unsig :: trait(Unsigned : Type);
  impl(i8, Unsig(Unsigned : u8));
  impl(generic(T : Type), where(T <: Unsig), T,
    mag : (fn(self : T) -> T.Unsigned)(T.Unsigned(self)));
  ```
  (`std/prelude.yo`'s `UnsignedCounterpart` ships on this.)
- **An associated CONSTANT in a VALUE position** works: `std/prelude.yo`'s six
  shift methods are one blanket impl over `T.BITS`.

So the gap is precisely: **a value-level associated constant is not
substituted when it appears in a TYPE position.**

## Root cause (expected)

This is the gap already recorded from the other direction in
`issues/retired/yo-self-stub-inventory.md:1782`:

> `impl.yo:369-375` — VALUE-level forall (`forall(U : usize)` array lengths) …
> KNOWN GAP: method types that mention `U` in a LENGTH position would need a
> value substitution, which `substitute()` cannot express

`substitute()` maps type parameters to types. An `Array(T, N)` length is a
VALUE, so there is no channel to rewrite it, and the unsubstituted length
degrades to 0 rather than to an error.

## Severity

The failure is loud here only because `Array_uint8_t_0` and
`Array_uint8_t_1` are different C types. **A length-0 result that the body
also happens to produce would compile**, so this is not reliably a compile
error — it is a silently wrong type that C usually catches. It should be a
diagnostic at minimum.

## What it blocks

`std/prelude.yo`'s byte conversions (`to_be_bytes`, `to_le_bytes`,
`from_be_bytes`, `from_le_bytes`) are written ten times, once per integer
type, because the return type is `Array(u8, N)` with `N` the receiver's width.
With this fixed they become one blanket impl over an associated
`BYTES : usize`, and `usize`/`isize` can have them at all — today they
deliberately do not, because (quoting `plans/STD_API_STABILIZATION.md`) "N
would be the target pointer width and a type-level size cannot be derived the
way `_USIZE_BITS` derives a value, so hard-coding 8 would be silently wrong on
wasm32".

The design work is in `plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`.

## Minimum fix, short of the full feature

Reject it. An associated constant (or a `forall` value parameter) appearing in
a type position should be a compile error naming the limitation, not a silent
0. That is a small change at the substitution site and removes the
silently-wrong-type case.

## Partial landing 2026-09-11 — the silent half is gone

The "minimum fix" above is implemented (`src/evaluator/types/array.yo`): a
length expression that is neither compile-time known nor a bare identifier is
now REJECTED with a diagnostic naming the limitation and pointing at
`plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`. `Array(u8, T.BYTES)`
in a signature therefore errors instead of quietly becoming
`Array_uint8_t_0`, and the "a length-0 result the body also produces would
compile" case above can no longer happen.

Covered by `tests/array.test.yo` — the rejection, plus an over-rejection
canary listing the length forms that MUST keep working (a literal, a
`comptime` binding, a `generic(N : usize)` parameter used by name).

**This issue stays OPEN**: the feature — a value channel in `substitute()`, so
an associated constant can be rewritten in a type position — is still missing,
and it is still what blocks collapsing `std/prelude.yo`'s ten byte-conversion
impl blocks and giving `usize`/`isize` byte conversions at all.
