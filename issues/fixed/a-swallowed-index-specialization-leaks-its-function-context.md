# A swallowed index specialization leaks its function context

**Severity:** S2: a valid function was rejected (E0605) after its body
subscripted a container whose generic `Index` impl failed to specialize. Its
`return(...)` was checked against the index method's result type.

**Status:** fixed on feat/vbd-v2b-index-mut (VALUES_BY_DEFAULT V2b).

## Symptom

This program is valid. With the subscript dispatched to a generic
projection-shaped `index` whose body branches, the caller's `return` failed:

```yo ignore
pragma(Pragma.AllowUnsafe);
VIndex :: (fn(comptime(Idx) : Type) -> comptime(Trait))(trait(Output : Type, index : (fn(self : &Self, idx : Idx) -> &Self.Output)));
L :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), L(T), VIndex(usize)(Output : T, index : (fn(self : &Self, idx : usize) -> &Self.Output)(cond((idx == usize(0)) => &self.v, true => &self.v))));
f :: (fn(al : L(u8)) -> i32)({
  b := al(usize(0));
  return(i32(b));
});
```

```
error[E0605]: Return type mismatch. Expected type "u8", but got "i32".
 --> r.yo:7:3
  |
7 |   return(i32(b));
```

The same error appeared in `std/string/string.yo` (`_split_impl`'s
`return(result)` after `al(pos)`), once std's `ArrayList` switched to the
projection-shaped `Index`.

## Root cause

There are two defects. The first one exposed the second.

1. **The specialization typed a projection body against `T`.** The specialized
   body of a generic function is evaluated with `ctx.expected_type` set to its
   result type (`src/evaluator/calls/helper.yo`). A projection's body yields
   the place's address (`rewrite_projection_tails`), so its `cond` / `match`
   tail must be typed against `*(T)`. With `T` expected, the `cond` was typed
   `u8` while its arms were `*(u8)`, and the specialization threw. The return
   check in `evaluate_begin_expression` has the same defect, and so do the
   all-arms-return types of `cond` and `match`. A projection's
   `return(&place)` was checked against `T`.
2. **The throw leaked the function-body context.** `_specialize_index_method`
   (`src/evaluator/calls/index_trait.yo`) swallows a specialization failure
   and falls back to the generic method value. The throw unwinds past the
   restores of the context the specialization had installed:
   `is_evaluating_function_body_or_async_block`, the captured-variable map,
   `self_type`, the specializing-function stack and others. The caller's later
   `return(...)` then read the index method's function type.

## Fix

- The specialization, the `begin` return check, and the all-arms-return types
  of `cond` / `match` use `*(T)` for a function whose `FuncMeta.result_is_ref`
  is set.
- `_specialize_index_method` runs the swallowing trial in its own function and
  restores the function-body context, and truncates the specializing stack,
  after it returns, whether or not the trial threw.

## Test

`tests/index.test.yo`, "V2b: a generic branching projection; the caller's
return keeps its type". It covers the generic `Pair2(T)` with an early
`return(&self.first)`, a `cond` tail, a `match` `index_mut`, and a caller that
widens and `return`s. It failed with E0605 before the fix.
