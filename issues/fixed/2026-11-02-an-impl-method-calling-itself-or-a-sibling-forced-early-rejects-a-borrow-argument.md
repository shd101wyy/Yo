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

## Status

FIXED 2026-11-02 on `fix/impl-method-recursive-borrow-arg`.

## Root cause

The doc's guess was close but not exact: the in-flight member's FuncVal does
carry its full signature. Phase A (`force_in_flight_field`,
`src/evaluator/values/impl.yo`) registers the member's FuncVal as a TYPE
TRAIT METHOD while its body is evaluated, so `W.walk(...)` is not resolved by
property access (as it is once `walk` is done) but by the receiver-method
dispatch in `evaluate_function_call` (`src/evaluator/calls/function.yo`,
the `.Some(method_info)` arm). That arm calls
`try_to_call_function_with_arguments` method-form (`is_method_call = true`),
which leaves argument 0 unpeeled as the receiver
(`apply_call_site_borrow_markers`' `first_is_receiver`). For a STATIC call
(`T.m(...)`, the receiver value is a type) no receiver is prepended, so
argument 0 is the first CALL argument, and its `&x` reached the evaluator's
address-of arm and was rejected. The `&x` in any later position was peeled
(`W.walk(d, &x)` passed), which pinned the cause. A sibling forcing the member
early takes the same path for every call inside it.

The unapplied-constructor form `G.m(&mut x, ...)` (decision 32) had already
hit this and peeled argument 0 against the method's first parameter before
the method-form call. The fix extends that peel to every static call:
`(uc_inf.bound || method_info.is_static)`.

## Test

`tests/forward_ref_impl_block.test.yo`: "a self-recursive impl method lends a
local to its own first parameter" (`&x` and `&mut out` recursion) and "an impl
method a sibling forces early lends a local to a call". Before the fix the
batch fails to compile with the `&mut x` / `&x` errors; after it both pass,
with the develop std and with B8's flipped std
(`origin/vbd/b8-arraylist-string-flip-r4`).
