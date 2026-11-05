# A `mut(name)` binding of a borrowed `match` writes through the shared reference

**Severity:** S1 — memory unsafety in safe code: a write to a `mut(d)` binding of a `&T` matched bare releases a `String` its owner still holds (ASan: heap-use-after-free), and a write to a `Copy` part changes the referent through a shared borrow.

Introduced by #1795 (`935c6ee69`, `issues/fixed/2026-11-05-a-borrowed-match-binding-returned-in-an-option-of-a-reference-dangles.md`), found the same day by the CLI case `field-write-through-a-match-binding-is-e0908` (GOLDEN-DIFF: its E0908 was gone).

## Symptom

```yo ignore
P :: struct(s : String, n : i32);
rename :: (fn(o : &Option(P)) -> unit)(
  match(o, .Some(mut(d)) => {
    d.s = String.from("new");
  }, .None => ())
);
```

Before #1795 this was E0908 ("`d` is a `match` or `for` binding, which borrows its value, and the old value holds data (String) that its owner still holds"). After it, it compiled, and the program from
`issues/repros/2026-11-06-a-mut-binding-of-a-borrowed-match-writes-through-the-shared-reference.yo`
reports `heap-use-after-free` under ASan.

With a reference binding matched bare, a `Copy` write reached the referent:

```yo ignore
o := Option(P).Some(P(n : i32(1), m : i32(2)));
r := &o;
match(r, .Some(mut(d)) => { d.n = i32(7); }, .None => ());
// o's n was 7: a write through the shared `r`. Before #1795 it stayed 1.
```

## Root cause

#1795 made every binding of a `&` match `is_ref`, a C pointer into the scrutinee's place. A
`mut(name)` binding is also `is_reassignable`. E0908's walk (`_borrowed_root_walk`,
`src/evaluator/exprs/assignment.yo`) reads `is_ref && is_reassignable` as a `&mut` binding,
which writes the place it names, so it stopped judging the write. Codegen then lowered
`d.n = 7` as `(*d).n = 7`, a write into the scrutinee.

## Fix

A `mut(name)` binding of a `&` match binds by value, as Rust 2021's `mut` resets the default
binding mode: it is a copy of its part, which the arm may write, as it was before #1795.

- `evaluate_match` (`src/evaluator/exprs/match.yo`) does not make a reassignable binding
  `is_ref`. When every binding of the match is `mut`, the match stays in the by-value
  `MATCH_MODE_BORROW` lowering.
- Codegen (`src/codegen/exprs/match.yo`) decides each binding on its own (`_binds_by_ref`, read
  from `is_mut_binding`): in the general test chain (`Bind`, `At` and an or-pattern's
  declarations), the tagged-union switch and the nullable binder. The other bindings of the
  same arm stay pointers.

E0908 judges a write into the copy again: a write of data the owner holds is rejected, and a
`Copy` write changes only the copy.

## Test

`tests/borrowed_match_binding_place.test.yo`:

- "a mut binding of a borrowed match is a copy of its part": a reference binding matched bare
  and a `&T` parameter matched bare leave the scrutinee untouched. A `mut(x)` beside a pointer
  binding `y` (switch and general lowerings) is a copy while `y` still writes through.
- "a mut binding of a borrowed match cannot release data its owner holds": the `String` write
  is E0908 again.

The CLI case `field-write-through-a-match-binding-is-e0908` matches its golden again.
