# E0912 flags a scalar field read through a local borrow as returning the borrow

**Severity:** S2 — a valid program is rejected: `{ v := r.as_ref(); v.m }` returning an `i32` field is E0912 "Cannot return the local borrow `v`"; the workaround is to read the field without the binding.

- Filed: 2026-11-08 (deref lane, VERDICTS-38 §5 item 3; Fable's probe p8a).
- Reproduced on develop `a25a71ee1` (a tree build), user file.
- Still reproduces on develop `beefabda4` (after #1834's projection-call `.*` fix), re-verified 2026-11-08.

## Reproducer

```yo
{ println } :: import("std/fmt");
S :: struct(m : i32);
use_s :: (fn(r : &Rc(S)) -> i32)({
  v := r.as_ref();
  v.m
});
main :: (fn() -> unit)({
  a := Rc.new(S(m : i32(5)));
  println(`${use_s(&a)}`);
});
export(main);
```

```text
error[E0912]: Cannot return the local borrow `v`: it borrows `r` with `&` and is second-class, so it may not cross the function boundary (no return, store, escaping capture or spawn).
  --> tmp/f3.yo:5:4
note: `v` borrows `r` here:
  --> tmp/f3.yo:4:3
```

`v.m` is an `i32` read through the borrow — a copy, not the borrow. The
escape walk treats the tail `v.m` as returning `v` itself. Writing the tail as
`r.m` (auto-dereference) is accepted.

A test belongs with the fix: the reproducer above prints `5`.

## Fixed

**Root cause.** The function-result escape check (`local_borrow_result_borrow_of`,
`evaluator/utils.yo`, called from `evaluator/exprs/begin.yo` at a `return(...)`
and at the result chain's tail) ran BEFORE the result expression was
evaluated, so it judged only syntax: a place "reached from" a local borrow
(`v`, or `v.m`) names the borrow. A field read through the borrow, `v.m`, is
the field's VALUE (a copy of a scalar), but the syntactic check could not see
the field's type.

**Fix.** A bare borrow (`v`) is still rejected before evaluation. A field place
(`v.m`) is judged after the result is evaluated, and is E0912 only when its
type is second-class (a reference field, still the borrow's own storage); a
copyable value is returned. `tests/local_borrows.test.yo` had a deliberate
negative for the same shape (`y := &sh.origin; return(y.x)`, decision 18's
"rejected even where reading through copies today", written before borrows
were references); it is now a positive test, per VERDICTS-38 section 5 item 3.

**Test.** `tests/origins/reference_read_rule.test.yo` (the reproducer, tail and
`return`; the bare borrow tail stays E0912) and `tests/local_borrows.test.yo`.
