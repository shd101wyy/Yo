# A closure that captures a fat reference (`&[T]`) by value emits invalid C

**Severity:** S2. A valid program that captures a `&[T]` binding by value (`{ v }`) in a closure is accepted by the
evaluator and then fails the C compile; the workaround is to pass the slice as a parameter or capture the owner.

Found 2026-11-15 by the VERDICTS-63 (Deref on `ArrayList` / `String`) probes (p10a, p10c, p9f). Seed `yo` 0.2.77 and
develop (`yo-dt6`) both fail. After the `str` flip every `&str` binding is a fat reference, so this reaches string
code too; check it against the `d49-str` lane's list before assigning it.

## Reproducer

`issues/repros/2026-11-15-a-closure-capturing-a-fat-reference-by-value-emits-invalid-c.yo`:

```yo
{ assert } :: import("std/assert");

count :: (fn(xs : &[i32]) -> usize)(xs.len());

main :: (fn() -> unit)({
  a := Array(i32, 3)(1, 2, 3);
  v := unsize(&a);
  (f : Impl(Fn() -> usize)) = ({ v }() => count(v));
  assert(f() == usize(3), "a `&[i32]` binding captured by value");
});
export(main);
```

```text
/tmp/v63r/out.bin.c:2311:132: error: indirection requires pointer operand ('__yo_slice_t' invalid)
 2311 |   __yo_t_17898030721966716192 __capture_closure_yo_id_4376513103651933933000000_0 = (__yo_t_17898030721966716192){ .__yo_v_v = (&((*__yo_v_v))) };
      |                                                                                                                                    ^~~~~~~~~
1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/v63r/out.bin.c
```

Compiled with `yo compile <file> --std-path ./std --optimize 2 --allocator system`.

## Root cause

The capture initializer emits `&(*v)` for the by-value capture of a reference binding. A fat reference is a
`__yo_slice_t` value, not a pointer, so the dereference is invalid C. The site is the capture-list arm of
`src/codegen/exprs/closures.yo` (`cfi.is_borrow`): the entry `{ v }` of a reference binding is a borrow entry whose
initializer is the place `v` refers to, rendered `(*v)`, and the arm stored `(&(<place>))` whatever the place's type.

## Expected

The closure copies the fat reference: `{ v }` captures the reference value.

## Fix

Fixed 2026-11-15 on `vbd/d49-str` (the `str` flip, decision 49 S2), where every `&str` binding is fat. A borrow
entry whose place is unsized stores the fat pointer the place was read through (`unsized_place_fat_code`, the
convention the other `&` sites use: `(*fat)` lends as `fat`); a sized place keeps `(&(<place>))`.

Tests: `tests/unsized_places.test.yo` ("a closure captures a &[i32] binding by value"; the batch failed to compile
before, on the seed) and `tests/str.test.yo` ("a closure captures a &str binding by value").
