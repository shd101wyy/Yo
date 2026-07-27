# yo-self: trait-dispatched pointer comparisons throw unify(i32, \*(i32)) — ptr/unsafe batch mains hollow

**Status:** OPEN — diagnosed 2026-07-28. Pre-existing since the pointer-operator
migration (`8acde607a`); NOT a cluster-B regression (verified identical under
the pre-batch binary; bisect cleared all five cluster-B pieces).
**Effect:** `tests/ptr.test.yo` and `tests/unsafe.test.yo` score HOLLOW on the
honest sweep — the whole batch `main` degrades. Also the likely root of
`issues/yo-self-ptr-eq-trait-call-in-shortcircuit.md` (the `||`-LHS subcase)
and the reason std/string's `String==` needed the direct `__yo_ptr_eq` local
extern instead of trait `==`.

## Repro (minimal, both fail the same way)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
open(import("std/fmt"));
main :: (fn() -> unit)({
  x := 12;
  p := &(x);
  q := unsafe(p.add(2));
  b := (q == p); // or (q > p) — ANY comparison operator
  println(`${b}`);
});
export(main);
```

TS: compiles + runs. yo-self: the `b := (q == p)` statement's eval THROWS on
the unswallowed spec path, the enclosing begin abandons everything after it
(per-statement FTTs incl. an unrelated trailing `println`), and the batch
`main` goes hollow.

## Diagnosis (diag-s1, `__YDBG2` at `_trial_eval_fn_body`'s swallow)

Discriminating message (only line vs a passing file's noise set):

```
Cannot unify incompatible types: "i32" and "*(i32)"
```

Thrown from `synthesizer.yo:1988` (tag-mismatch fallback). Expected side
`i32`, given side `*(i32)` — the dispatch for `==`/`>` on a `*(i32)` receiver
is checking the argument against a NON-pointer candidate (an `Eq(i32)`-class
impl param) and the arg-type-check throws hard instead of the resolver moving
on to the correct `Eq(*(T))`/`Ord(*(T))` prelude impl
(std/prelude.yo:5554-5582, target `*(T)`, `Self := *(T)` — the impl itself is
well-formed; `_substitute_self_in_method_ty` and `_find_self_level_in_method_ty`
handle `Self`/`*(Self)` fine).

Suspected mechanism (the recorded landmine family): registry-keyed dispatch on
a POINTER receiver — `type_id_or_empty(*(T)) = ""` (no Pointer arm), so
pointer impls key into the empty-id bucket and the operator-candidate lookup
for the receiver falls back to a wrong bucket / global candidate whose first
entry is a non-pointer `==`. NEXT PROBE: find the operator-dispatch candidate
enumeration for `q == p` (try_to_call route / type_trait_methods lookup on the
receiver), print the candidate list + which entry the unify runs against, and
compare with TS's resolution (TS emits the comparison as plain C infix by
inlining the impl's single-builtin body — `__yo_ptr_gt` et al ARE registered in
BOTH compilers' codegen constants; only the eval-side resolution diverges).

## Facts established

- `p.add(2)` / method forms work (emitted correctly); ONLY the comparison
  operators fail, and they fail at EVAL (begin-abandonment), not emission.
- Both `==` and `>` fail identically → the whole Eq/Ord-on-pointer family.
- TIER 2 was green for the migration because no battery/corpus/std code path
  exercises a trait-dispatched pointer comparison (String== uses the direct
  builtin workaround).
- Repro files: `/tmp/pgt.yo`, `/tmp/peq.yo`, `/tmp/ptr_repro.yo` (block 0 of
  tests/ptr.test.yo).
