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

## Fix

`call_is_index_place` (the hook behind `scr_is_marked_index_place` in `evaluate_match`) is `_is_index_place` in `src/evaluator/calls/index_trait.yo`. It now accepts any projection chain that contains an element access, not only `xs(i)` on a variable. `_place_chain_type` walks the chain statically, before the scrutinee is evaluated, and computes the type of each step:

- a field `.f` of a value struct or labelled tuple, read through a `&T` slot. A `ref` struct, a source namespace or a cell handle ends the place, since their fields lie behind a handle;
- `.*` through a raw pointer or a reference slot. A reference binding's `r.*` reads the binding's own type;
- an element access `recv(i)` whose receiver type dispatches `Index`. The element type is the output of the receiver's single `index` method. A receiver with several `index` methods still counts as a place, but no further step may follow it.

The chain must end at a runtime binding. A compile-time binding, a function call or a method call yields `.None`, and `s.m(i)` counts as an element access only when `m` is a field of `s`'s type. `_chain_has_index_step` keeps plain field paths on `is_place_expression`'s route. A marked chain through an element is evaluated in place, like `match(&xs(i), …)`, so nothing is copied and the E0901 is gone.

Test: `tests/match_structs.test.yo`, "a marked match through a field of an element, or an element behind a field or a pointer". It covers the three reproducers and asserts that the element is read in place: it is still there, with its contents, after the match. All three reproducers fail on the v0.2.74 seed with E0901.

The `&mut` variants the Recommendation asks for are not part of this fix. `match(&mut xs(i), …)` is rejected on develop too ("`&mut` lends a place, and `xs(i)` is a temporary"), with or without a projection after the element, as is the local borrow `q := &mut xs(i)`, whose error says to borrow an element through `for(&mut coll, x => …)`. A `&mut` borrow of an element is a separate design question. The "is a temporary" wording for an element access is filed as `issues/2026-11-05-a-mut-match-of-an-element-says-the-element-is-a-temporary.md`.
