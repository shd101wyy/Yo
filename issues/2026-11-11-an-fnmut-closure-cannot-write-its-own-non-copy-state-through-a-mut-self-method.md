# An `FnMut` closure cannot write its own non-Copy state through a `&mut self` method

**Severity:** S2. Valid programs are rejected: an `FnMut` literal whose by-value capture-list entry holds a
`String` or an `ArrayList` cannot call a `&mut self` method on it (`acc.push_str(…)`, `acc.push(…)`) or lend it
`&mut` to a helper. Both are E0908, "`acc` is a `match` or `for` binding, which borrows its value", although decision
37 makes exactly these entries writable. The workaround is to replace the whole value by assignment. Pre-existing:
v0.2.76 gives the same E0908.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C5). Confirmed on develop `64f33c710`. Related:
`issues/e0908-calls-an-untyped-self-receiver-a-match-or-for-binding.md` reports the same wrong noun for an untyped
`self ->` lambda parameter, where the REJECTION is correct; it does not cover this rejection, which is itself wrong.

## Reproducers

`issues/repros/2026-11-11-an-fnmut-closure-cannot-write-its-own-non-copy-state-through-a-mut-self-method.yo`
(expects: accept, printing `OUT: 20`):

```yo
main :: (fn() -> unit)({
  (mut(f) : Impl(FnMut() -> usize)) = ({ acc : String.from("") }() => {
    acc.push_str("0123456789");
    acc.len()
  });
  _a := f();
  println(`OUT: ${f().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76:
error[E0908]: Cannot pass `acc` as the `self : &mut Self` receiver: `acc` is a `match` or `for` binding, which
borrows its value, and holds data (String) that its owner still holds. The callee writes it, and the write would land
in the borrowed copy alone. To change it, copy it into a local first (`q := acc.*;`) …
```

- `…-helper.yo` (expects: accept): `grow(&mut acc)` with `grow :: (fn(s : &mut String) -> unit)(…)`. E0908 ("Cannot
  pass `acc` as the `&mut` parameter `s`").
- `…-assign.yo` (control, accepted): `acc = String.from("0123456789")` writes the same entry by assignment; runs clean,
  `OUT: 10`.

## The family (develop `64f33c710`)

| Shape (`(mut(f) : Impl(FnMut() -> usize)) = ({ acc : … }() => …)`) | Verdict | Correct |
| --- | --- | --- |
| `String` state, `acc.push_str(…)` | E0908 | accept |
| `ArrayList(i32)` state, `acc.push(i32(1))` | E0908 | accept |
| `String` state lent to `grow(&mut acc)` | E0908 | accept |
| the same through `Dyn(FnMut() -> usize)`, called 100 times | E0908 (ledger) | accept, no leak |
| `acc = String.from(…)` (assignment) | accepted, `OUT: 10` | accept |
| `Array(i32, 2)` state written element-wise (`tests/fn_mut.test.yo`) | accepted | accept |
| `acc = (acc + String.from(…))`: moves `acc` out of the state | E0913 (ledger) | E0913 |

## Root cause

`evaluate_anonymous_function_implementation` (`src/evaluator/values/anonymous_function.yo`) binds an `FnMut`
literal's by-value entry as a writable but NON-owning local (`ce_owned` is true only for `FnOnce`;
`ce_fnmut_state` adds `mark_fnmut_capture_value_binding`). `binding_require_mut` (`src/evaluator/utils.yo`) exempts
such a binding ("A by-value capture-list entry of a closure typed `FnMut(...)` is part of the record its call borrows
exclusively"), which is why the assignment control passes. The `&mut` argument check does not:
`require_no_inout_write_through_borrow` (`src/evaluator/exprs/assignment.yo`) asks `_borrowed_root_walk` whether the
argument's root borrows its value. `_borrowed_root_walk` returns `.None` only for an owning, `is_ref`-and-reassignable,
compile-time-only or module-level binding; the state entry is none of these, so it is reported as a borrowed copy
whenever its type holds counted data (`is_judged`). The noun falls through to "a `match` or `for` binding" because the
entry is not `is_parameter`, the defect the related doc describes for a different binding.

## Expected

Accepted. `plans/VALUES_BY_DEFAULT.md` decision 37 (N1f): "Under an `FnMut` slot a capture list's by-value entries
are writable (… the `FnMut` call borrows the persistent record)". A `&mut self` call on the entry writes the record the
call holds exclusively, as the assignment does; there is no borrowed copy for the write to be lost in. The fix adds
the `is_fnmut_capture_value_binding` exemption to `_borrowed_root_walk` (or binds the entry as owning the record's
field). Under `Fn` and `FnOnce` the existing verdicts stay.

## Test

With the fix: `tests/fn_mut.test.yo` gains the `String` `push_str`, `ArrayList` `push` and `grow(&mut acc)` cases as
accepted programs run under ASan, and the `Dyn(FnMut)` form with a leak check; the three repro files move there.
