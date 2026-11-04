# `match(&mut p.*.f, …)` through a raw-pointer parameter is rejected as a write through a read-only `&` borrow

**Severity:** S2 — a valid program is rejected with a wrong diagnosis: `p` is a raw pointer (`p : *(T)`), not a `&` borrow, and the place behind it is writable; the workaround is to lend the place to a local first.

Found by the README example-project rehearsal for v0.2.75 (markdown_it_yo's `Token.attr_push`, `self : *(Self)`, `match(&mut self.*.attrs, .Some(attrs) => attrs.push(…), …)`). Reproduced with the v0.2.74 seed and with develop d76eac577.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
T :: struct(xs : Option(ArrayList(i32)));
push_one :: (fn(p : *T, v : i32) -> unit)(
  match(&mut p.*.xs, .Some(xs) => xs.push(v), .None => ())
);
main :: (fn() -> unit)({
  mut(t) := T(xs : .Some(ArrayList(i32).new()));
  push_one(addr_of(t), i32(7));
  println(`${match(&t.xs, .Some(xs) => xs.len(), .None => usize(0))}`);
});
export(main);
```

```text
error[E0908]: Cannot match `&mut ((p.(*)).xs)`: `p` is a `&` borrow, which is read-only.
  --> rawmatch.yo:6:17
help: match it with `&((p.(*)).xs)`, or take `p` as `p : &mut T`
```

Expected: it compiles and prints `1`. Writing the same place through a local borrow is accepted and prints `1`:

```yo ignore
push_one :: (fn(p : *(T), v : i32) -> unit)({
  q := &mut p.*.xs;
  match(q, .Some(xs) => xs.push(v), .None => ())
});
```

## Root cause

`_decide_match_mode` (src/evaluator/exprs/match.yo) handles a `&mut` scrutinee (marker 2) by walking the place to its root variable with `_scrutinee_root_variable`, then rejecting the match when `_variable_is_imm_borrow(root)` holds. The walk follows every `.` access, including `.*`, so for `p.*.xs` it stops at `p`. `p` is an unmarked parameter, which the predicate treats as a read-only borrow. A raw-pointer dereference starts a new place, though: what lies behind `p.*` is not part of `p`'s storage, so `p`'s mutability says nothing about it. The local-borrow path (`q := &mut p.*.xs`) already gets this right.

## Recommendation

Stop the root walk at a `.*` whose operand is a raw pointer (a `*(T)`), and do not apply the read-only check past it. Unsafe code that dereferences the pointer already owns the aliasing obligation. Add the reproducer above as a test expecting `1`, and add the `&`-parameter case (`p : &T`, `match(&mut p.*.xs, …)`), which must stay E0908.
