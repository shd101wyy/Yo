# A local borrow that a macro expansion declares is never live in the caller's code

**Severity:** S2 — an access that conflicts with a live `&mut` local borrow is accepted when the borrow comes from a macro's template, so after V2b's flip a borrowed `for` over a value collection could free the buffer its element points into.

Filed 2026-10-17 while building decision 39's Generation A
(`plans/VALUES_BY_DEFAULT.md`, decision 39, "the shape, settled
2026-10-17").

## Symptom

The prelude's borrowed `for` now takes a local borrow of its source in the
macro's own code and keeps it live for the whole loop:

```yo ignore
// for(&mut xs, x => body) expands to
{
  c := &mut xs;
  cur := c.walk_start();
  while(c.walk_valid(&cur), cur = c.walk_next(&cur), {
    x := c.walk_elem(&cur);
    body
  });
}
```

A body that names `xs` should be E0911, as the same code written by hand is:

```yo
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  for(&mut xs, x => {
    xs.push(x); // accepted: no E0911
  });
});
export(main);
```

With the new prelude and develop's evaluator (`yo-dev-5425cd7bf`, develop
at #1380) this compiles, while the hand-written expansion is E0911. At run
time the `ref` list's borrow flag still panics, so it is a panic instead of
a compile error. After B8 (value collections, no flag) nothing would catch
the push, and the element borrow `x` would dangle after a reallocation.

## Root cause

A local borrow's live range is a token interval, and the conflict check
compares positions only within one module (`_lb_live_at` and
`_lb_tok_after`, `src/evaluator/utils.yo`):

```yo ignore
_lb_live_at :: (fn(info : &LocalBorrowInfo, tok : &Token) -> bool)(
  (tok.module_path == info.decl.module_path) && ((tok.character > info.decl.character) && (tok.character <= info.end.character))
);
```

A macro expansion mixes two modules. The template's tokens (`c`, its
binding, the loop) carry the macro's module (`std/prelude.yo`), and the
caller's arguments (`xs`, the body) carry the caller's. So `c`'s range lies
in the prelude, every access in the body lies in the caller's file, and no
access is ever in range.

## Fix

A local borrow that a macro expansion declares in its own template code is
live across the whole macro call, in the caller's coordinates.

- The macro-call evaluator (`src/evaluator/calls/function.yo`, where an
  `unquote` macro's expansion is evaluated) pushes the call's first and last
  tokens (`local_borrow_push_macro_site`) around the expansion's evaluation.
- `local_borrow_register` checks the innermost site. If the borrow's name
  token is in another module than the call (template code), the borrow's
  `start` and `end` become the call's extent, and it records the call as its
  `macro_site`. `_lb_live_at` reads `start` in place of `decl`.
- Borrows the caller writes inside the call (a user's own `y := &mut z` in a
  `for` body) are in the caller's module and keep their ordinary last-use
  range. The element binding `x` of a `for` is one of them: its name token is
  the caller's.
- The E0911 message for such a borrow points at the macro call ("this macro
  call borrows `xs` for its whole extent"), and its help names the element
  binding and `indices()`.
- The site stack is part of `LocalBorrowMark`, so a block or a
  `comptime_expect_error` that is thrown through restores it.

**Limit.** A macro defined in the module that calls it is not covered: its
template tokens share the caller's module, so the borrow keeps its
last-use range in template tokens. Only the prelude's `for` declares a local
borrow in a template today (grep of `std/` and `tests/`).

## Test

`tests/for_macro_borrow.test.yo`: `push_on_the_borrowed_collection`,
`read_of_the_borrowed_collection` and `insert_into_the_borrowed_map` are
`comptime_expect_error`s that compile without the fix. The cli-case
`borrowed-for-push-same-variable-is-e0911` pins the message.
