# A cursor held in a reference field cannot be re-pointed through its match binding: `c.cur = &mut n.next` is E0911

**Severity:** S3: a sound program is rejected (a precision gap, not a soundness one); the workaround walks in a function over the slot (`push_last(&mut c.cur.*, v)` with `push_last :: (fn(slot : &mut Option(Box(Node)), v : i32) -> unit)`, whose local `cur := &mut slot.*` the VERDICTS-71 re-point exception admits); a local cursor `cur := &mut c.cur.*` in the holder's own body is rejected ("A local borrow cannot reach through a pointer dereference").

Found 2026-11-25 by the VERDICTS-78 Q1 lane, checking the verdict's edge 7 ("the cursor in a field"), which the verdict left unverified and assigned this outcome if the code could not do it in v0.2.81.

## Reproducer

```yo
{ println } :: import("std/fmt");
Node :: struct(v : i32, next : Option(Box(Self)));
C :: struct(cur : &mut Option(Box(Node)), n : i32);
main :: (fn() -> unit)({
  mut(list) := Option(Box(Node)).Some(Box.new(Node(v : i32(1), next : .None)));
  mut(c) := C(cur : &mut list, n : i32(0));
  while(
    c.cur.is_some(),
    match(
      &mut c.cur.*,
      .Some(n) => {
        c.cur = &mut n.next;
      },
      .None => ()
    )
  );
  c.cur.* = .Some(Box.new(Node(v : i32(3), next : .None)));
  println(&c.n);
});
export(main);
```

```text
error[E0911]: Cannot write `c.cur` here: `n` borrows `c.cur` with `&mut` and is still live, and a `&mut` borrow is exclusive: while it is live, `c.cur`, the places inside it and the places containing it are reached only through `n`.
```

Rust accepts the same walk (`c.cur = &mut n.next` with `c.cur : &mut Option<Box<Node>>`). The one-step form (no loop) is E0911 too once `list` is read after the walk.

## Root cause

The local-borrow place model (`LocalBorrowPlace`, `src/evaluator/utils.yo`) records the arm binding of `match(&mut c.cur.*, …)` as a borrow of the place `c.cur`: the referent of a reference field and the field's slot are one place there. The store `c.cur = &mut n.next` writes the slot, so `local_borrow_access` sees a write of the place `n` freezes and raises `_lb_raise_conflict`. A local cursor is admitted by the VERDICTS-71 re-point exception (`local_borrow_require_no_live_derived`'s `through`: the binding the right-hand side goes through is skipped), which is keyed on a local borrow binding, so a field place never reaches it.

## Fix direction

Key the re-point exception on the place, as the verdict asks: a store into a reference field's slot is not an access of the referent it held, and the binding the right-hand side goes through is skipped as it is for a local `cur`. The old target stays held until the holder's last use (edge 3, union not replacement).

## Test

`tests/origins/unsound/v78-field-cursor-walk.yo` (`// expect: E0911`) pins today's rejection; the fix renames it a `-pos` twin that runs under ASan.
