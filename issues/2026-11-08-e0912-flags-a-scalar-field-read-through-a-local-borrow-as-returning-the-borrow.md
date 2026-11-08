# E0912 flags a scalar field read through a local borrow as returning the borrow

**Severity:** S2 — a valid program is rejected: `{ v := r.as_ref(); v.m }` returning an `i32` field is E0912 "Cannot return the local borrow `v`"; the workaround is to read the field without the binding.

- Filed: 2026-11-08 (deref lane, VERDICTS-38 §5 item 3; Fable's probe p8a).
- Reproduced on develop `a25a71ee1` (a tree build), user file.

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
