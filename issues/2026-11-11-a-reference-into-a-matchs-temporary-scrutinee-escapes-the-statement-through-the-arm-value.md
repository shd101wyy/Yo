# A reference into a match's temporary scrutinee escapes the statement through the arm value

**Severity:** S1 (the audit ledger's first guess was S2; it is a use-after-free in safe code). `p := match(&mkb(),
.Some(Box(s)) => Option(&String).Some(s), .None => Option(&String).None);` passes `yo check`: the scrutinee is a
temporary of the `:=` statement, the arm value points into it, and `p` is read after the statement dropped it
(ASan: heap-use-after-free). Pre-existing: v0.2.76 accepts it too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A22). Confirmed on develop `64f33c710`. Related:
`issues/2026-11-11-a-block-or-arm-value-computes-its-origin-after-its-own-locals-are-gone-so-a-holder-over-them-carries-none.md`
(A12): the arm value's origin is computed after the arm binding `s` left scope.

## Reproducers

`issues/repros/2026-11-11-a-reference-into-a-matchs-temporary-scrutinee-escapes-the-statement-through-the-arm-value.yo`
(negative, expects E0911, R-TEMP's "its value holds a reference into …, a temporary that ends with this statement"):

```yo
L :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
mkb :: (fn() -> Option(Box(String)))(.Some(Box.new(L())));
main :: (fn() -> unit)({
  p := match(&mkb(), .Some(Box(s)) => Option(&String).Some(s), .None => Option(&String).None);
  match(p, .Some(s) => println(`OUT: ${s.*}`), .None => ());
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-list.yo` (negative, E0911): `p := match(&mkl(), xs => Option(&ArrayList(String)).Some(xs));`, an element read
  through `p` afterwards. No ASan report: the dropped list reads as empty, and the read aborts with "ArrayList: index
  out of bounds".
- `…-pos.yo` (positive control): the scrutinee is bound first (`t := mkb(); p := match(&t, …)`).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `match(&mkb(), .Some(Box(s)) => Option(&String).Some(s), …)` bound with `:=`, read after | accepted, heap-use-after-free | E0911 |
| `match(&mk(), .Some(s) => Option(&String).Some(s), …)` over an `Option(String)` temporary (ledger v07: `OUT:` prints an empty string) | accepted | E0911 |
| `match(&mkl(), xs => Option(&ArrayList(String)).Some(xs))` (ledger v07c: length 0; `…-list.yo`: index out of bounds) | accepted | E0911 |
| the same over a bound scrutinee `t` (`…-pos.yo`) | accepted | accept |

## Root cause

`bind` sees an empty set: `YO_DEBUG_N2B=1` prints `bind p: roots=[] rhs=match(&mkb(), …)`. Two steps lose the
temporary. The borrowed `match` (`src/evaluator/exprs/match.yo`) registers an arm binding's loan through `imm_place`
= `local_borrow_place_of(&scrutinee_expr, …)`, a structural place walk; `mkb()` is no binding's place, and
`is_temporary_operand` / `origin_temporary_entry` (R-TEMP, `src/evaluator/utils.yo`) are never applied to a `match`
scrutinee, so `s` gets no entry naming the hidden statement local. Then, as in A12, R-ARM's `match` clause in
`_origin_of_into` evaluates the arm value `Option(&String).Some(s)` after the arm's scope closed; the fallback in
`_origin_push_lend` / `_holder_roots_into` for a vanished arm binding finds no registered entry. The first step is
the defect of this issue; fixing only A12's evaluation point would still yield an empty set here.

## Expected

The arm bindings of `match(&temp, …)` borrow the scrutinee, a hidden statement local (R-TEMP); the arm value carries
that entry, and `bind` rejects `p` through `_reject_temporary_root` as it rejects the corpus row
`holder-from-temporary`: "Cannot bind `p` to …: its value holds a reference into …, a temporary that ends with this
statement". `BORROW_CHECKER_COMPLETENESS.md` §3:
R-LEND "a temporary operand is a hidden statement local (R-TEMP)"; R-ARM "the arm bindings of a borrowed scrutinee
carry the scrutinee's origin (decision 26)". P2's temporary-extension rule (§7) extends only a `&temporary` in a `:=`
initializer's extending positions — "the initializer itself, a constructor field, a tuple/array component, an arm tail
of the initializer"; a `match` scrutinee is not one, so this stays an error after P2, as in Rust.

## Test

With the fix: both negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`match-temporary-scrutinee-arm-escapes` (neg, E0911) and `match-bound-scrutinee-arm` (pos) in
`tests/origins/corpus.tsv`, beside `holder-from-temporary`.
