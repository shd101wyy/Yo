# A `match` through a borrowed element copies the element

**Severity:** S2 — `match(&xs(i), …)` is rejected with E0901 when the element type is not implicitly copyable (a move-only value, plain data without `Copy`), although it is the repair E0901 itself names for `match(xs(i), …)`. Code that matches a collection's element has to move the match into a helper that takes `p : &T`.

**Status:** FIXED 2026-10-18 (PR #1471). **Found:** 2026-10-17, converting `Pattern` to a value enum with `Box` children (VBD V4, `feat/vbd-v4-pattern-box`). Reproduces on the v0.2.63 seed and on a tree-built stage 1 of develop `5425cd7bf`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
S :: struct(a : i32);
main :: (fn() -> unit)({
  xs := ArrayList(S).new();
  xs.push(S(a : i32(3)));
  match(&xs(usize(0)), S(a : v) => println(v));
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `xs(usize(0))`, whose type `S` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
  --> m2.yo:7:10
```

The same shape over an enum with a `Box(Self)` child (`P :: enum(Leaf(v : i32), At(sub : Box(Self)))`, `match(&xs(usize(0)), .Leaf(v) => …, .At(Box(s)) => …)`) fails the same way. Lending the element to a parameter works: `f(&xs(usize(0)))` with `f : (fn(p : &S) -> unit)` compiles and runs.

## Expected

Decision 26's delegated rules (`plans/VALUES_BY_DEFAULT.md`, "A projection scrutinee") make `match(xs(i), …)` of an explicit-copy type E0901 *naming `&xs(i)`*. `match(&xs(i), …)` should borrow the element in place, as a `&xs(i)` argument does: `MATCH_MODE_BORROW`, bindings borrow, nothing is copied or dropped.

## Cause (suspected)

The parser peels the `&` marker off a `match` scrutinee and records it in `g_borrowed_match_sites` (`src/expr.yo`); `_decide_match_mode` (`src/evaluator/exprs/match.yo`) then returns `MATCH_MODE_BORROW` for marker 1. But the scrutinee `xs(i)` was already evaluated as a value before the mode is decided, and that evaluation reads the element through the `Index` projection as a copy, which the copy check (`src/evaluator/utils.yo`, "it is borrowed from the value that holds it") rejects. An argument `&xs(i)` is evaluated as a lent place and skips that copy.

## Fix direction

Evaluate a marked (`&` / `&mut`) projection scrutinee the way a lent argument is evaluated, so the element is read in place, and make sure codegen's borrow match reads the element through the projection without a dup or a drop. The regression test is the reproducer above plus the `Box(Self)` enum variant of it, in `tests/match_structs.test.yo` or a new match test.

## Fix

The suspected cause was right, one level up: `is_place_expression`
(`src/evaluator/exprs/match.yo`) accepts only atoms and field chains, so an
element scrutinee took the `evaluate_begin_expression` route, whose
single-expression tail attach re-registers the projection's temp as OWNING —
and owning a projection's element means COPYING it out (E0901 for a
move-only element). A marked (`&`; also `&mut`, which fails earlier today on
the temporary-lend rule and is out of this issue's Expected) element-access
scrutinee now takes the `evaluate_expression` route, which leaves the
projection's temp NON-OWNING — the same in-place read a `&xs(i)` argument
gets. Detection is `call_is_index_place` (a new hook in
`src/evaluator/context.yo`, installed by `calls/index_trait.yo` beside the
write-promotion hook, since `exprs/match.yo` cannot import
`calls/index_trait.yo` without a cycle): a one-argument non-infix call
`recv(i)` whose receiver is a RUNTIME binding of a type that dispatches
`Index` (`has_index_impl`) — a closure or function call of the same shape is
not an index place, and a compile-time-only receiver is not a place.

Codegen needed no change: the borrow-mode match already read the scrutinee
place; the tests below run under the leak verdict with no leak and no
double-free, and assert the list still owns its elements afterwards.

## Verification

- `tests/match_structs.test.yo`, "a match through a borrowed element of a
  move-only struct" and "a match through a borrowed element of a
  Box-children enum": the reproducer (plain-data `S`, move-only) and the
  `Box(Self)` enum variant, each asserting the bound fields' values AND that
  the list still owns both elements afterwards. Fails before (E0901 at the
  scrutinee, `&xs(usize(1))`), passes after; 11 passed in the file, with the
  leak verdict ON (no leak, no over-release).
- The doc's own reproducer compiles and runs (`println(&v)` prints 3).
- `check ./src` and `check ./std` green under the tree binary;
  match_async_arms 26, parameter_modes 44, move_only 55, fn_once 23,
  match_primitive_values 3, and `tests/internal/match_binding_shadow` 3 —
  all green.
- `match(&mut xs(i), …)` still reports the pre-existing "`&mut` lends a
  place, and `xs(usize(0))` is a temporary" — the root-variable machinery
  does not see an element place as a lendable root; that is decision 26's
  separate `mut`-place question, not this issue's Expected (`MATCH_MODE_BORROW`).
