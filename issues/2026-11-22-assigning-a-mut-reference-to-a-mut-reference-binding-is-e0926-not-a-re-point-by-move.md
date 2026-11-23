# Assigning a `&mut` reference to a `mut` reference binding is E0926, not a re-point by move

**Severity:** S2 — a valid re-point (`a = m` with `a`, `m : &mut T`) is rejected with advice to write through `a` instead; the workaround is a new binding (`b := m`) or the spelled lend `a = &mut m.*`.

Found while implementing VERDICTS-76 Q1 (`a := m` moves a `&mut` reference; the Fable review's edge-case row 10).

```yo ignore
main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(1);
  m := &mut x;
  mut(a) := &mut y;
  a = m; // error[E0926]
  a.* = i32(2);
});
export(main);
```

```
error[E0926]: `a` is a reference (`&mut i32`): writing the value it refers to is spelled `a.* = …`
  --> r10.yo:6:3
  |
6 |   a = m;
  |   ^
help: write `a.* = …`; `a = &place` re-points the reference (`yo fix --migrate deref` inserts the `.*`)
```

## Root cause

The whole-value write of a reference binding (`src/evaluator/exprs/assignment.yo`, the
`variable_is_reference_binding` arm before `is_deref_write`) treats every `a = v` whose right side is
not a lend `&place` as a write of the referent. When the right side is itself a reference of `a`'s own
type, the assignment is a re-point by move.

## Required behaviour (VERDICTS-76 review, row 10)

`a = m` re-points `a` by move: `a`'s old loan ends, `a` takes over `m`'s places (no new loan is minted,
as for `a := m`), and `m` is consumed (a later use is E0901). The E0926 arm must not fire when both sides
are the same reference type. A test in `tests/origins/unsound/` (positive and a use-of-`m` negative)
lands with the fix.
