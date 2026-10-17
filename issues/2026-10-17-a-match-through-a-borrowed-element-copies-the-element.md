# A `match` through a borrowed element copies the element

**Severity:** S2 — `match(&xs(i), …)` is rejected with E0901 when the element type is not implicitly copyable (a move-only value, plain data without `Copy`), although it is the repair E0901 itself names for `match(xs(i), …)`. Code that matches a collection's element has to move the match into a helper that takes `p : &T`.

**Found:** 2026-10-17, converting `Pattern` to a value enum with `Box` children (VBD V4, `feat/vbd-v4-pattern-box`). Reproduces on the v0.2.63 seed and on a tree-built stage 1 of develop `5425cd7bf`.

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
