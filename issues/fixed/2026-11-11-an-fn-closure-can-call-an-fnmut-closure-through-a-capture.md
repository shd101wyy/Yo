# An `Fn` closure can call an `FnMut` closure through a `&` capture

**Severity:** S2. `(g : Impl(Fn() -> i32)) = ({ r : &f }() => r());` passes `yo check` although `f` is `FnMut`: the
call `r()` takes `f`'s record as `&mut self` through a read-only `&` borrow. Two such `Fn` closures over one `f` both
mutate its state (`OUT: 1 2 3` from three calls of two "read-only" holders), and an `Fn` value is no longer free of
side effects on what it borrows. No memory error was found from it, so it stays S2 (invalid program accepted, bounded).
Pre-existing: v0.2.76 accepts it too. The same call through a local `r := &f` is E0908.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A47). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-an-fn-closure-can-call-an-fnmut-closure-through-a-capture.yo` (negative, expects E0908):

```yo
main :: (fn() -> unit)({
  (mut(f) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => {
    n = (n + i32(1));
    n
  });
  (g : Impl(Fn() -> i32)) = ({ r : &f }() => r());
  (h : Impl(Fn() -> i32)) = ({ r : &f }() => r());
  a := g();
  b := h();
  c := g();
  println(`OUT: ${a.to_string()} ${b.to_string()} ${c.to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
OUT: 1 2 3
```

- `…-pos.yo` (positive control): `(mut(g) : Impl(FnMut() -> i32)) = ({ r : &mut f }() => r());`. Accepted,
  `OUT: 1 2`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `Fn` closure `{ r : &f }() => r()`, `f : Impl(FnMut(...))` | accepted, mutates `f` | E0908 |
| two such closures over one `f`, calls interleaved | accepted, `OUT: 1 2 3` | E0908 |
| `r := &f; r()` (a local `&` borrow) | E0908 ("Cannot call `r`, an `FnMut(...)` closure, whose call borrows it exclusively: `r` is a `&` borrow") | E0908 |
| `FnMut` closure `{ r : &mut f }() => r()` | accepted, `OUT: 1 2` | accept |

## Root cause

`_require_exclusive_fnmut_callee` (`src/evaluator/calls/function.yo`) implements decision 37's receiver rule for an
`FnMut` callee with three checks, none of which recognises a `&` capture-list entry:

- `shared_borrow_param_root_of_place` (`src/evaluator/exprs/assignment.yo`) returns a root only when it `is_imm_borrow`, the flag
  of a `&T` parameter; the capture entry is bound with `variable_set_is_ref(…, true)` and
  `variable_set_reference_mut(…, false)` (`evaluate_anonymous_function_implementation`), not `is_imm_borrow`;
- `local_borrow_write_expr` judges local borrow bindings (`r := &f`, the E0908 control); a capture entry is not one;
- `place_require_mut` → `binding_require_mut` (`src/evaluator/utils.yo`) returns early for any `is_ref` binding,
  read-only or not.

So the callee check passes and the body is typed `Fn`, since its only capture is `&`.

## Expected

E0908 at `r()`, as for the local `&` borrow. `plans/VALUES_BY_DEFAULT.md` decision 37: "An `FnMut` call is a `&mut self`
receiver call: E0917 through an unmarked binding or a by-value parameter, E0908 through `&` (a parameter, a `&Dyn`,
a local `&` borrow) …". A `&` capture is a `&` borrow of the same kind (`REFERENCES_AND_ORIGINS.md` O7: a capture
entry spells origins like a field, `{ y : &(T, y) }`), so the list should read "a parameter, a `&Dyn`, a local `&`
borrow or a `&` capture". The fix makes the callee check reject an `is_ref` binding whose stated mode is `&`
(the mode `variable_set_reference_mut` records in the bound type) instead of passing it.

## Test

With the fix: the negative program and the positive control move to `tests/origins/unsound/`; `tests/fn_mut.test.yo`
gains the E0908 case and the local-`&`-borrow control, and a corpus row `fnmut-call-through-ref-capture` (E0908) in
`tests/origins/corpus.tsv`.

## Fix

`reject_write_through_shared_capture` (`src/evaluator/utils.yo`), called from `place_require_mut` in every tree:
a write of a `&` capture-list entry — the binding is `is_ref`, has a `BorrowCaptureOuter` record and its slot type is
a shared reference — is E0908 "Cannot call the `FnMut(...)` closure `r`: it is the `&` capture `r : &f`, a read-only
borrow." `_require_exclusive_fnmut_callee` reaches it through `place_require_mut`, so the `FnMut` call through
`{ r : &f }` is rejected as the local `r := &f` is; `reject_implicit_capture_write` skips capture-list entries.

Tests: `tests/origins/unsound/c2-fn-closure-calls-fnmut-ref-capture.yo` (E0908),
`c2-fn-closure-calls-fnmut-ref-capture-pos.yo` (accept); `tests/fn_mut.test.yo` "an `FnMut` closure called through a
`&` capture is E0908".
