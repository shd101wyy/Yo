# A marked `match` scrutinee is copied (E0901) unless it is exactly `xs(i)` on a plain variable

**Severity:** S2 — a valid program is rejected: `match(&xs(i).f, …)`, `match(&s.xs(i), …)` and `match(&p.*.xs(i), …)` are read-only borrows of a place, yet each is evaluated as a copy and fails with E0901 for a move-only type. The E0901 text names the `&` marker as the repair, and the marker is already there.

Found by the README example-project rehearsal for v0.2.75 (markdown_it_yo: `match(&tokens(usize(i)).children, …)` in the renderer, `match(&state.*.tokens_meta(usize(curr)), …)` in the emphasis and strikethrough post-processors). Present on develop d76eac577 and on the v0.2.74 seed.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
T :: struct(c : Option(ArrayList(i32)));
S :: struct(metas : ArrayList(Option(ArrayList(i32))));

// 1. a field of a borrowed element
count_field :: (fn(ts : &ArrayList(T)) -> usize)(
  match(&ts(usize(0)).c, .Some(c) => c.len(), .None => usize(0))
);
// 2. an element of a collection reached through a field (a reference root)
count_ref :: (fn(s : &S) -> usize)(
  match(&s.metas(usize(0)), .Some(m) => m.len(), .None => usize(0))
);
// 3. the same through a raw pointer
count_ptr :: (fn(p : *S) -> usize)(
  match(&p.*.metas(usize(0)), .Some(m) => m.len(), .None => usize(0))
);
export(count_field, count_ref, count_ptr);
```

```text
error[E0901]: use of moved value: cannot copy `ts(i).c`, whose type `Option(ArrayList(i32))` is move-only, and it cannot be moved either: it is a field of another value, …
error[E0901]: use of moved value: cannot copy `(s.metas)(usize(0))`, whose type `Option(ArrayList(i32))` is move-only, and it cannot be moved either: it is borrowed from the value that holds it (an element, …
```

The shape `match(&xs(i), …)` with `xs` a plain variable is accepted. So is matching the element with a struct pattern, which is the workaround for case 1: `match(&ts(usize(0)), T(c : .Some(c)) => …, _ => …)`. For cases 2 and 3 the workaround is to take the element out with `std/mem` `replace`, match the local, and put it back.

## Root cause

`evaluate_match` (src/evaluator/exprs/match.yo) has two in-place routes for the scrutinee:

- `is_place_expression`, which recognizes variables and field paths rooted at one;
- `scr_is_marked_index_place`, which requires `call_is_index_place(scrutinee)`, an index call directly on a variable.

Every other marked scrutinee falls through to `evaluate_begin_expression`, which attaches an owning temporary. Owning an element's projection means copying it out, which is the E0901 (the comment above the routes describes exactly this failure for `match(&xs(i), …)`, fixed in `issues/fixed/2026-10-17-a-match-through-a-borrowed-element-copies-the-element.md`). A field of an element (`xs(i).f`), and an element of a collection reached through a field or a dereference (`s.xs(i)`, `p.*.xs(i)`), are places too, but neither predicate accepts them.

## Recommendation

Treat a marked scrutinee as a place whenever it is a projection chain (field accesses, `.*` and index calls) that ends at a variable, and route it through `evaluate_expression` the way `match(&xs(i), …)` already is. A test should cover the three functions above, each returning the length, together with `&mut` variants whose arms push to the matched list and check the caller sees the push.
