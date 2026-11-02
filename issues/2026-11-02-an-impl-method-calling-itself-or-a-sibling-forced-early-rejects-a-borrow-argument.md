# An impl method that calls itself, or that a sibling forces early, rejects a `&x` argument

**Severity:** S2: a valid program is rejected. A `&x` argument in a call to
an inherent impl method is refused as "not an expression of its own" while that
method is still being evaluated. This happens when the method calls itself
recursively, or when a sibling method referenced it before its definition. A
top-level function with the same body is accepted. Workaround: bind the
borrow to a local first (`x_ref := &x;`) and pass `x_ref`.

## Symptom

The develop binary at b02a4c908 (#1727) rejects this file:

```yo
{ String } :: import("std/string");
W :: struct(_d : i32);
impl(
  W,
  walk : (fn(s : &String, d : usize) -> usize)({
    x := String.from("ab");
    if(d > usize(0), {
      return(W.walk(&x, d - usize(1)));
    });
    s.len()
  })
);
main :: (fn() -> unit)({
  t := String.from("x");
  _n := W.walk(&t, usize(2));
});
export(main);
```

The error:

```text
error: `&x` lends a borrow: it is written as a call argument to a `&T` parameter, as a `match` scrutinee, or as a local borrow (`y := &x`), and is not an expression of its own. ...
  --> e.yo:8:21
```

Other cases:
- Binding the result instead (`_m := W.walk(&x, ...)`) fails the same way.
- A top-level `walk :: (fn(s : &String, d : usize) -> usize)(...)` that calls
  `walk(&x, ...)` passes.
- A non-recursive method calling an already-defined sibling (`W.leaf(&x)`)
  passes.
- If a sibling defined above calls `W.walk(s)`, which forces `walk` before its
  definition, any `&x` call argument inside `walk` fails. The note says "`walk`
  was evaluated here because a sibling method of this impl references it
  before its definition".

Found in the B8/B9 VBD probe: `src/evaluator/effects/mutation_summary.yo`'s
`_MsW.walk` recursion over a macro expansion (`_MsW.walk(&mx, table, touched)`).

## Root cause (to confirm)

A call argument `&x` is peeled into a lend only when the callee's parameter is
known to be `&T` (`src/evaluator/exprs/_expr.yo`, the `BF_ADDRESS_OF` arm: "a
call argument lending to an `imm` parameter is peeled before evaluation"). A
method still in flight has no finished function type for the call path to
consult. The argument then reaches the address-of arm unpeeled and is
rejected. A top-level function in the same position works, so the method
dispatch path must lack the def-time parameter view that a top-level
recursive call gets.

## Test

To land with the fix: a language test with the self-recursive method above
and the sibling-forced variant, both accepted.
