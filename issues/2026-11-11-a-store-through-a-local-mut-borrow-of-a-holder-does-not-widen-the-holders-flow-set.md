# A store through a local `&mut` borrow of a holder does not widen the holder's flow set

**Severity:** S1. `p := &mut slot; p.* = .Some(&y);` with `slot : Option(&T)` re-points the holder `slot` at
`y`, but the store's join lands on the borrow `p`, not on `slot`. `slot` keeps its old flow set, so a read of `slot`
after `y`'s block ends passes `yo check` (ASan: stack-use-after-scope; heap-use-after-free once the referent owns
heap). The same holds for a field write through the borrow (`p.o = …`), for a borrow of a sub-place
(`p := &mut w.h`), and for a store through a HOLDER of a `&mut &T` (`m := M(rp : &mut r); m.rp.* = ri`). The first
three are pre-existing (v0.2.76 accepts them); the `&mut &T` holder form is new with P3 (#1841).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A25). Confirmed on develop `64f33c710`. The fix of
`issues/fixed/2026-11-08-a-store-through-a-mut-lend-of-a-reference-does-not-widen-its-flow-set.md` covers only a
borrow of a whole REFERENCE binding (`rp := &mut r; rp.* = ri`); this is the same hole for every other holder.

## Reproducers

`issues/repros/2026-11-11-a-store-through-a-local-mut-borrow-of-a-holder-does-not-widen-the-holders-flow-set.yo`
(negative, expects E0911):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
main :: (fn() -> unit)({
  mut(slot) := Option(&Rc(X)).None;
  {
    y := mk();
    p := &mut slot;
    p.* = .Some(&y);
  };
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope
$ YO_DEBUG_N2B=1 yo check repro.yo
[n2b] join p: roots=[y(imm)] value=.Some(&(y))
```

- `…-field.yo` (negative, E0911): `p := &mut h; p.o = .Some(&y);` with `H :: struct(o : Option(&Rc(X)), n : i32)`.
- `…-subplace.yo` (negative, E0911): `p := &mut w.h; p.* = H(r : &y, n : i32(1));`, then `w.h.r` is read.
- `…-ref-ref-field.yo` (negative, E0911): `M :: struct(rp : &mut &Rc(X))`, `m := M(rp : &mut r); m.rp.* = ri;`
  with `ri := &inner` block-local, then `r` is read: stack-use-after-scope. The fixed issue's shape with the
  `&mut &T` held in a struct field instead of a local borrow (a `&mut &String` field does not compile yet:
  `issues/2026-11-11-a-struct-with-a-mut-ref-ref-field-passes-check-and-its-c-names-an-undeclared-type.md`).
- `…-pos.yo` (positive control): the same store through `p := &mut slot`, with `y` declared before `slot`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `p.* = .Some(&y)` through `p := &mut slot`, `p` declared inside or outside `y`'s block | accepted, stack-use-after-scope | E0911 |
| `p.o = .Some(&y)` through `p := &mut h` | accepted, stack-use-after-scope | E0911 |
| `p.* = H(r : &y, …)` through `p := &mut h` or `p := &mut w.h`; through `ri := &inner` | accepted, stack-use-after-scope | E0911 |
| the same with a holder whose user `Drop` reads the field | accepted, stack-use-after-scope in `drop` | E0911 |
| `m.rp.* = ri` through `m := M(rp : &mut r)`, `rp : &mut &Rc(X)` | accepted, stack-use-after-scope | E0911 |
| `p.* = .Some(&y)` in one scope, then `y = mk()` while `slot` is live (ledger) | accepted, reads the new value | E0911 at the write |
| the holder's type spells its origin (`H(z)`, `Option(&(Rc(X), (a, b)))`), store through `p` | E0923 | E0923 |
| the same writes without the borrow: `h = H(r : &y, …)`, `h.o = .Some(&y)` | E0911 | E0911 |
| `rp := &mut r; rp.* = ri` on a reference binding `r` (the fixed issue) | E0911 | E0911 |

## Root cause

Verified in the source. A whole-value store `p.* = v` is evaluated as an assignment to the variable `p`, and its
`=` join (`bind_join`, `src/evaluator/utils.yo`) runs against `p`. `_join_through_mut_self_lend`
(`src/evaluator/exprs/assignment.yo`) re-routes that join to the lent place only when the lent place is ONE place
with no steps, its root is a reference binding (`variable_is_reference_binding(&js_r) && js_r.is_ref()`), and `p`'s
own type is a borrow of it. A holder (`Option(&T)`, a struct with `&` fields) is not a reference binding, and
`&mut w.h` has a step, so the join stays on `p`, whose range ends with the block: no scope check fires and `slot`'s
set is unchanged. A field write through the borrow (`p.o = v`) takes the property path's `place_write_join`
(`src/evaluator/utils.yo`), whose root is `_place_root_variable(p.o)`, again `p`. A spelled holder is caught only
because the subset check reads the declared origin off `p`'s pointee type.

The `&mut` capture of a closure already has the right mechanism: `bind_join_roots_for` sends a store through a
`&mut` capture to the outer place (`borrow_capture_outer`, `_capture_store`). A local `&mut` borrow has no such
redirect. The same holds one level further out: `m.rp.* = ri` writes `r` through a `&mut` held in `m`'s field,
and the join again lands on the variable the place is rooted at (`m`), not on the lent place `r`.

## Expected

E0911 at the store (or at the read of `slot`): `y`'s scope ends while `slot` is live. A `&mut` borrow is a path to
its place, so a write through it is a write of that place: `BORROW_CHECKER_COMPLETENESS.md` §5's place-write row
("`p.* = v`, `p.f = v` … the target holder's set grows by `origin_of(v)`") and `REFERENCES_AND_ORIGINS.md` O3's
place writes. The holder whose set grows is the borrow's lent place's root (`slot`, `h`, `w`, `r`), for a whole-value
store through the borrow a GEN on that root (the borrow may point at a sub-place, so nothing of the root is killed).

## Test

With the fix: the four negative programs and the positive control move to `tests/origins/unsound/` beside
`p3-mut-ref-store-inner.yo`; corpus rows `store-through-local-mut-borrow-of-holder` (E0911) and its `-field` and
`-subplace` twins.
