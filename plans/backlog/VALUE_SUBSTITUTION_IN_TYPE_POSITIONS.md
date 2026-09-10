# Value substitution in type positions (const generics that actually generalize)

**Status:** BACKLOG — designed here, not started. Written 2026-09-10 after
measuring exactly which half of the feature is missing.

## The gap, measured

Yo has three ways to parameterize a member over a type, and two of them work:

| shape | status | evidence |
| --- | --- | --- |
| associated TYPE in a type position (`-> T.Unsigned`) | **works** | `std/prelude.yo`'s `UnsignedCounterpart`; probe 2026-09-10 |
| associated CONSTANT in a value position (`n >= T.BITS`) | **works** | `std/prelude.yo`'s six shift methods, one blanket impl |
| associated CONSTANT in a TYPE position (`-> Array(u8, T.BYTES)`) | **broken — silently resolves to 0** | `issues/associated-constant-in-a-type-position-resolves-to-zero.md` |

The third is this document's subject. It is the same gap recorded from the
`forall` side in `issues/retired/yo-self-stub-inventory.md:1782`:

> VALUE-level forall (`forall(U : usize)` array lengths) … KNOWN GAP: method
> types that mention `U` in a LENGTH position would need a value substitution,
> which `substitute()` cannot express

## Root cause

`substitute()` (`src/evaluator/values/impl.yo` and the type machinery it
calls) maps **type parameters to types**. An `Array(T, N)` carries `N` as a
VALUE, so a substitution has no channel to rewrite it. The unsubstituted
length then degrades to 0 instead of erroring, which is how a signature ends
up as `Array_uint8_t_0` while its body emits `Array_uint8_t_4`.

## What it blocks

- **`to_be_bytes` / `to_le_bytes` / `from_be_bytes` / `from_le_bytes`** — ten
  per-type copies in `std/prelude.yo`, because the result is `Array(u8, N)`
  with `N` the receiver's width. One blanket impl with this fixed.
- **`usize`/`isize` byte conversions at all.** They are deliberately absent
  today: `N` is the target pointer width, and `plans/STD_API_STABILIZATION.md`
  records that "a type-level size cannot be derived the way `_USIZE_BITS`
  derives a value, so hard-coding 8 would be silently wrong on wasm32".
  `BYTES : usize` as an associated constant, set from the same
  target-dependent expression `_USIZE_BITS` uses, is exactly the derivation
  that is missing.
- **`Array(T, N)`'s `Default`.** `plans/STD_API_STABILIZATION.md` records that
  it "needs a runtime element-wise initializer Yo has no spelling for yet" —
  a `default()` generic over `N` is the same substitution problem.
- **Any user API returning a fixed-size buffer whose size follows the type.**
  Hashes (`SipHasher13` → `Array(u8, 8)`), fixed-width encodings, SIMD-ish
  lane counts.

## Design

### Step 1 — make it an error, not a 0 (do this first, independently)

A value parameter or associated constant appearing in a type position that
substitution cannot rewrite must be a diagnostic naming the limitation. Today
it silently becomes 0, and `Array_uint8_t_0` vs `Array_uint8_t_1` being
different C types is the ONLY reason the current failure is loud — a
length-0 result the body also produces would compile.

This is a small change at the substitution site plus a `comptime_expect_error`
test, and it removes a silently-wrong-type class from the language whether or
not the rest of this plan is ever done.

### Step 2 — a value-substitution channel

`substitute()` needs a second map: value parameters → comptime values,
threaded through the same call sites as the type map. Concretely:

1. **The substitution map grows a value half.** Wherever a
   `TypeParam → TypeValue` binding is recorded (generic impl matching,
   specialization, `forall` binding), record `ValueParam → EvalValue` too.
2. **`Array(T, N)`'s `N` becomes substitutable.** The length is an expression
   in the type's stored form; substitution must walk it and replace value
   parameter references, then re-evaluate it at comptime. This is the same
   walk `substitute()` already does for the ELEMENT type — the missing piece
   is that it stops at the length.
3. **Associated constants resolve through the same path as associated types.**
   `find_associated_type_from_generic_impls` (`impl.yo:1862`) already resolves
   `T.Assoc` for types from the generic impl registry; the constant case needs
   the sibling lookup, returning an `EvalValue` rather than a `TypeValue`.
4. **Type keys must include the value.** `Array(u8, 4)` and `Array(u8, 8)` are
   different types and already key differently; the risk is a specialization
   cache keyed only on the type half, which would collide two widths into one
   emitted function. This is the class
   [[yo-self-recursive-instantiation-era-split-fixed]] warns about — diff by
   `type_key`, never by the C comment.

### Step 3 — adopt in `std/`

Behind a seed gate, as always ([[yo-seed-gate-blocks-std-using-new-runtime-macros]]):
add `BYTES : usize` to the integer types beside `BITS`, collapse the four byte
conversions to one blanket impl each, and give `usize`/`isize` the conversions
they currently lack.

## Acceptance

- The repro
  (`issues/repros/associated-constant-as-an-array-length-in-a-return-type.yo`)
  compiles and runs, printing `1 4`.
- A `comptime_expect_error` test pins Step 1's diagnostic for a case the
  substitution genuinely cannot handle.
- BYTE IDENTITY on the fixpoint corpus for a tree that has not adopted the
  feature — the mechanism is additive, so nothing already compiling may
  change ([[yo-byte-identity-gate-for-additive-codegen-change]]).
- After adoption: `u8.from_be_bytes(u8(0x42).to_be_bytes()) == u8(0x42)` and
  the same at every width, plus `usize`, which is new — and the wasm32 leg
  must pass, since that is the target the hard-coded-8 hazard was about.

## Why not const generics in full

Rust's const generics are a much larger feature (const parameters on types and
functions, const arithmetic in bounds, `where` clauses over consts). Nothing
in `std/` needs that. What is needed is narrow: **a value that is already
fixed per-instantiation must survive substitution into a type position.**
Scoping to that keeps the change inside `substitute()` and its map, and leaves
the larger design open.
