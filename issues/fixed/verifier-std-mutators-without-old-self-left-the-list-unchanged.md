# Verifier: std `insert`/`remove`/`swap_remove`/`swap` never mentioned `old(self)`, so a call left the list unchanged

**Severity:** S1 — `yo verify` reported `ok` for false contracts (a false proof) about any list passed through `insert`, `remove`, `swap_remove` or `swap`, and REFUTED true ones.

- **Status:** FIXED on `feat/verifier-dml-fixtures` (2026-09-30).
- **Component:** `std/collections/array_list.yo` (the `assumed()` contracts)
  and the call-site rule of R1 slice 2 in `src/verifier/vc.yo`.

## Summary

R1 slice 2's call-site rule rebinds a list argument to a fresh term **only
if** the callee's contract mentions `old(<param>)`
(`issues/questions/modifies-clause-for-callee-side-effects.md`). A contract
without it promises the argument unchanged. For `assumed()` std bodies the
only gate was review: that question doc's recommendation said "every
mutator in `std/collections/array_list.yo` already writes its
`old(self.len())` clause". That was wrong. Only `push` did. `insert`,
`remove`, `swap_remove`, `swap`, `drain` and `set_len` carried a
`requires` and no `ensures`, so the verifier kept the receiver's pre-call
term across every call to them. The FV docs' subset table repeated the
wrong claim ("`push`/`insert`/`remove` relate `len()` to `old(len())`").

## Reproducer (measured: compiler built at develop `5101639ad`, std of the same commit)

`tests/spec/fixtures/negative/dml_list_mutators_false.yo`, four false
claims, e.g.

```rust
rem_same :: (fn(xs : ArrayList(i32), requires(xs.len() >= usize(1)), ensures(xs.len() == old(xs.len()))) -> (r : i32))(
  xs.remove(usize(0))
);
```

```
verify: 4 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, ...
```

Its true twin `tests/spec/fixtures/valid/dml_list_mutators.yo` gave
`1 ok, 4 refuted` (only `swap`, which keeps the length, proved).

## Fix

Each mutator's contract now relates the new length to `old(self.len())`:

| method | added `ensures` |
| --- | --- |
| `insert` | `self.len() == (old(self.len()) + usize(1))` |
| `remove`, `swap_remove` | `self.len() == (old(self.len()) - usize(1))` |
| `swap` | `self.len() == old(self.len())` |
| `drain` | `self.len() == (old(self.len()) - (r.end - r.start))` |
| `set_len` | `self.len() == new_len, self.capacity() == old(self.capacity())` |

`set_len`'s second clause is true (it never reallocates) and is also what
tells the verifier the call changes `self`. A bare
`ensures(self.len() == new_len)` would have been worse than none: no rebind,
so callers would assume both "unchanged" and "length is `new_len`".

With the same compiler and the patched std: the negative fixture is
`4 refuted`, the valid one `5 ok`. `drain` and `set_len` are unreachable from
verified code today (a range literal and the uncontracted `capacity()` are
subset errors), measured with a probe calling each. Their clauses are for
when that changes. The uncontracted mutators (`clear`, `truncate`, …) are
"call to a callee without contracts" subset errors.

Runtime: every added `ensures` is also a runtime assert in the default mode
(`assumed()` skips the proof, not the check), so `yo test ./std` executes
them.
