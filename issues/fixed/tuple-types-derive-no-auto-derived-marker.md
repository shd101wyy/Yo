# Tuple types derive NO auto-derived marker — `Type.impls(Tuple(i32), Comptime)` is `false` (FIXED 2026-09-05)

**Status: FIXED.** `src/evaluator/trait_checking.yo`, step 4b of
`type_implements_trait`: a `.Tuple` arm alongside `.Struct` / `.EnumT` (a value
aggregate holds a marker iff every field type holds it), and the step's
recursion guard is now keyed by the type's STRUCTURAL rendering when it has no
nominal id — which also fixes the nested case (`*(*(i32))` was not `Send`).
Regression tests + over-accept canaries in `tests/basic.test.yo`.

**Severity: reflection gap (under-approximation).** Every marker trait answers
`false` for every tuple type: `Comptime`, `Send`, `Runtime` and `Acyclic`
alike. The identical nominal struct answers `true` for all four.

**Found** 2026-09-05, by making `comptime_assert` fire inside a function body
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).
`tests/basic.test.yo`'s "Test type auto derive Comptime" has asserted the
correct answers since the marker traits were introduced (PR #16, TS era) — the
assertions had simply never run, in either compiler.

## Reproducer

```rust
{ println } :: import("std/fmt");
NonSend :: ref(struct(v : i32));
_C1 :: Type.impls(Tuple(i32), Comptime);
_C2 :: Type.impls(Tuple(Box(i32)), Comptime);
_S1 :: Type.impls(Tuple(i32), Send);
_R1 :: Type.impls(Tuple(i32), Runtime);
_A1 :: Type.impls(Tuple(i32), Acyclic);
SPair :: struct(a : i32, b : i32);          // the nominal control
_CS :: Type.impls(SPair, Comptime);
_SS :: Type.impls(SPair, Send);
_RS :: Type.impls(SPair, Runtime);
_AS :: Type.impls(SPair, Acyclic);
main :: (fn() -> unit)({
  println(`Tuple(i32)      Comptime = ${_C1}   struct control = ${_CS}`);
  println(`Tuple(Box(i32)) Comptime = ${_C2}`);
  println(`Tuple(i32)      Send     = ${_S1}   struct control = ${_SS}`);
  println(`Tuple(i32)      Runtime  = ${_R1}   struct control = ${_RS}`);
  println(`Tuple(i32)      Acyclic  = ${_A1}   struct control = ${_AS}`);
});
export(main);
```

Measured on v0.2.24 (and unchanged by PR #429):

```
Tuple(i32)      Comptime = false   struct control = true      WRONG
Tuple(Box(i32)) Comptime = false                              ok (Box is an object)
Tuple(i32)      Send     = false   struct control = true      WRONG
Tuple(i32)      Runtime  = false   struct control = true      WRONG
Tuple(i32)      Acyclic  = false   struct control = true      WRONG
```

## Root cause

A tuple is STRUCTURAL: `type_id_or_empty`
(`src/evaluator/values/type_trait_methods.yo`) has no `.Tuple` arm, so a tuple
has no nominal id and the marker registry — which
`auto_derive_traits_for_struct_type` writes and step 4 of
`type_implements_trait` reads — can never hold an entry for one. The prelude
declares `impl(generic(T : Type), where(T <: Comptime), *(T), Comptime())` and
the `Array(T, U)` equivalents, but nothing for `Tuple`. And step 4b of
`type_implements_trait` (`src/evaluator/trait_checking.yo`), the on-demand
re-derivation that recomputes a marker from a type's fields, matches only
`.Struct`, `.EnumT` and `.Pointer`. A tuple therefore reaches no rule at all
and falls out `false`.

The retired TypeScript compiler has the same hole
(`typeImplementsComptimeBuiltin`, `git cat-file -p
src-attic-final:src/evaluator/trait-checking.ts`, has no tuple case either), so
this is not a porting regression — the assertions were written as a statement
of intent and were never executed.

### Second defect in the same block

Step 4b's recursion guard is keyed `"${type_id}:${trait_id}"`. For a structural
type `type_id` is `""`, so EVERY structural type shares the single key
`":<trait>"` — a nested one finds its own ancestor's entry and is cut, which is
why `*(*(i32))` is not `Send` today. Structural types are finite trees and can
only recurse through a NOMINAL type (which keeps its own id in the guard), so
keying them by their structural rendering is both terminating and precise.

## Fix

`src/evaluator/trait_checking.yo`, step 4b:

* add a `.Tuple` arm alongside `.Struct` / `.EnumT` — a tuple is a value
  aggregate, so a marker holds iff every field type holds it;
* key the guard by `type_to_string(target)` when the nominal id is empty.

## Regression tests

`tests/basic.test.yo` already asserts the three `Comptime` cases. Added
alongside them: the `Send` / `Runtime` / `Acyclic` answers for a tuple, the
negative canaries (`Tuple(Box(i32))` is not `Comptime`, a tuple of a non-`Send`
object is not `Send`), and the nested cases the guard-key defect hid
(`Tuple(Tuple(i32))`, `*(*(i32))`).
