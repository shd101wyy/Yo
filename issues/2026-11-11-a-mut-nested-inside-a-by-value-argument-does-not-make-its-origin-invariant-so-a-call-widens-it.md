# A `&mut` nested inside a by-value argument does not make its origin invariant, so a call widens it

**Severity:** S1. O3-3's own example type, `Slot(p) :: struct(dst : &mut Option(&(T, p)))`, passed BY VALUE —
`put(Slot(x)(dst : &mut slot), &y)` — lets `put` store `&y` into a slot declared over `x` that outlives `y`. The
same holds when the `&mut` sits in a tuple, an `Option`, or a user generic struct or enum. Accepted,
heap-use-after-free. Pre-existing: v0.2.76 accepts the same programs.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A24). Confirmed on develop `64f33c710`. The `&mut Slot(p)`
spelling of the same call is rejected (corpus row `store-widen-named-holder`); only the by-value positions are open.

## Reproducers

`issues/repros/2026-11-11-a-mut-nested-inside-a-by-value-argument-does-not-make-its-origin-invariant-so-a-call-widens-it.yo`
(negative, expects E0923):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Slot :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(dst : &mut Option(&(Rc(X), p))));
put :: (fn(generic(p : Origin), s : Slot(p), v : &(Rc(X), p)) -> unit)({
  s.dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := Rc.new(X(s : String.from("x")));
  mut(slot) := Option(&(Rc(X), x)).Some(&x);
  {
    y := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    put(Slot(x)(dst : &mut slot), &y);
  };
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-tuple.yo` (negative, E0923): `put(generic(p), w : Tuple(&mut Option(&(Rc(X), p)), i32), v : &(Rc(X), p))`
  called as `put((&mut slot, i32(0)), &y)`: heap-use-after-free.
- `…-pos.yo` (positive control): the slot is declared over `(x, x2)`, both outliving it, and `put` stores `&x2`
  through a by-value `Slot((x, x2))`. Accepted, runs clean (`OUT: 72`).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `s : Slot(p)` by value, `Slot(p)` holding `&mut Option(&(T, p))` | accepted, UAF | E0923 |
| `w : Tuple(&mut Option(&(T, p)), i32)` | accepted, UAF | E0923 |
| `w : Option(&mut Option(&(T, p)))`; a user `E(Y)` enum or `W(Y)` struct at `Y := &mut Option(&(T, p))` (ledger) | accepted, UAF | E0923 |
| `put(generic(T : Type), w : W(&mut Option(T)), v : T)` at `T := H`, `H` a holder (no origin parameter at all) | accepted, UAF | E0923 or E0911 |
| `s : &mut Slot(p)` (top-level `&mut`), `self : &mut Slot(p)` | E0923 | E0923 |
| a `cond` join of two `&mut`-held slots, a typed re-binding to `Slot((x, y))`, a widening helper `-> Slot((p, q))` (ledger) | E0923 | E0923 |

## Root cause

`lend_through` (`src/evaluator/calls/function.yo`) is the one place O3 step 3's exact unification is applied at a
call. Its step 1 collects the origin parameters an argument FIXES only for slots where
`t_slot_is_mut_ref(&slot) && type_carries_origin(&t_slot_pointee(&slot))` holds — a parameter whose own type is a
`&mut` reference (`t_slot_is_mut_ref`, `src/types/definitions.yo`, matches only `.Reference(_, mutable, _)` at the
top). A by-value `Slot(p)`, `Tuple(&mut …, i32)` or `Option(&mut …)` parameter is a struct, tuple or enum at the top,
so its argument fixes nothing; step 2 (every other argument within the fixed set, E0923) then has nothing to compare
`&y` against, and step 3 (the flow write-back) is gated on the same predicate. `p` is left to ordinary covariant
inference from both arguments, which admits `y`.

The `T := H` row is a neighbour with a different route: there is no origin parameter for `lend_through` to fix,
and `T` unifies the holder types without their origins.

## Expected

E0923 at `&y`, as for the `&mut Slot(p)` spelling. `plans/backlog/REFERENCES_AND_ORIGINS.md` O3 step 3 makes a
type constructor's origin parameter invariant "iff some field places it under a `&mut` pointee, a `RefCell` payload
or a `&mut` capture" (`Slot(T, p)` is its example), and, restated 2026-11-11 for this finding: "The rule holds
wherever the type stands in a signature: a by-value `s : Slot(T, p)` argument, a tuple or `Option` wrapping a
`&mut(Option(&(T, p)))`, and a user generic struct instantiated at one are checked exactly as the top-level `&mut`
parameter of the example is." `lend_through` step 1 must walk the parameter type for every `&mut` position (through
struct fields, tuple components and enum payloads) and fix the origins under each.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
beside `store-widen-named-holder` in `tests/origins/corpus.tsv`: `store-widen-by-value-holder` and
`store-widen-tuple-mut-pointee` (both E0923).
