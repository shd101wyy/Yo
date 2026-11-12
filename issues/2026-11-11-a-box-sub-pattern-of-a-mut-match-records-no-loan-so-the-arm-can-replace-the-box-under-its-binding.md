# A `Box` sub-pattern of a `&mut` match records no loan, so the arm can replace the box under its binding

**Severity:** S1. `match(&mut b, Box(s) => { b = Box.new(…); use(s) })` passes `yo check`: `s` is a bitwise copy
of the `String` inside the box, nothing freezes `b` while `s` lives, and the arm's write frees the buffer `s`
still points at (ASan: heap-use-after-free; with `Box(mut(s))` and a write of `s`, double free). Pre-existing:
v0.2.76 accepts every reproducer too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A15). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-box-sub-pattern-of-a-mut-match-records-no-loan-so-the-arm-can-replace-the-box-under-its-binding.yo`
(negative, expects E0911):

```yo
main :: (fn() -> unit)({
  mut(b) := Box.new(L());
  match(
    &mut b,
    Box(s) => {
      b = Box.new(String.from("q"));
      println(`OUT: ${s}`);
    }
  );
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

The emitted C binds `s` by value: `String __yo_v_s = (*(Box payload of __yo_v_b));`, a second owner of the
buffer.

- `…-double-free.yo` (negative, E0911): `Box(mut(s))`; the arm replaces the box, then writes `s`, whose
  assignment drops the buffer the replacement already freed: double free.
- `…-mut-parameter.yo` (negative, E0911): the scrutinee is a `&mut` parameter, `match(r, .Some(Box(s)) => { r.* = .None; use(s) })`:
  heap-use-after-free.
- `…-pos.yo` (positive control): the box is replaced after the arm's last use of `s`; runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `match(&mut b, Box(s) => { b = …; use(s) })` | accepted, UAF | E0911 |
| `match(&mut o, .Some(Box(s)) => { o = .None; use(s) })` | accepted, UAF | E0911 |
| the same with the write in a guard or through `kill(&mut o)` in the arm or guard (ledger g02b/d/f) | accepted | E0911 |
| `Box(s)` nested in a struct, tuple, enum payload, `Option(Option(…))` or an or-pattern (ledger p01, p03–p05, o03) | accepted (p03: UAF) | E0911 |
| `r := &mut o; match(r, .Some(Box(s)) => { r.* = .None; … })`, and a `&mut` parameter `r` | accepted, UAF | E0911 |
| `match(&mut b, Box(mut(s)) => { b = …; s = … })` | accepted, double free | E0911 |
| `match(&b, Box(s) => { b = …; … })` (a `&` match) | E0911 naming `s` | E0911 |
| `match(&mut o, .Some(bx) => { o = .None; … })`, `.Some(x)` over `Option(String)`, `P(a : aa, …)` (no `Box` step) | E0911 naming the binding | E0911 |

## Root cause

Confirmed in `src/evaluator/exprs/match.yo`. A `&mut` match runs its patterns through `_augment_arm_pattern`
with `add_hidden = false` ("only classifies"). The `.ThroughBox` arm walks its sub-pattern with `in_cell = true`,
and the `.Bind` arm pushes every binding found there onto `_ArmOwnership.borrowed` ("the user's bindings below a
cell: borrows, never owners or places"). The arm loop then makes a binding a `&mut` place (`place_vars`, later
`local_borrow_register_match_place` against `mut_place`) only when
`(consuming || mut_places) && !_names_contain(&own.borrowed, b.name)`. A binding below the box is therefore
neither a place nor a registered borrow: nothing is recorded, and codegen emits the by-value copy. The `&`
match differs because its `imm_place` registration runs for every binding, below a cell or not.

This follows `plans/VALUES_BY_DEFAULT.md` decision 26 as written ("In a `&mut` match, bindings below a cell or a
raw pointer are copies"), which dates from when every cell was a shared, counted handle. A `Box` is a unique
owner: a bitwise copy of its payload aliases an owned buffer, the hazard decision 26 already rejects for a
`mut(name)` binding of a `&` match (`_throw_mut_match_copy`, E0901).

## Expected

E0911 at the write of `b` (or `o`, `r.*`) while `s` is live: R-ARM in `plans/backlog/BORROW_CHECKER_COMPLETENESS.md`
("the arm bindings of a borrowed scrutinee carry the scrutinee's origin"), with the `&mut` lend exclusive
(decision 47 step 2). Either the binding below a `Box` becomes a place into the payload registered like any other
`&mut` place binding, or, keeping decision 26's "copies", a part that is not `Copy` is E0901 as the `&` match's
`mut(name)` copy is. The silent alias is not an option.

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`mut-match-box-subpattern-write` (E0911) and its `-pos` twin in `tests/origins/corpus.tsv`; a row in
`tests/match_binding_lend.test.yo` for the `Box(mut(s))` form.
