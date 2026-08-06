# yo-self: forward-ref static `Self.method` callee not collected → undeclared function

**Status:** FIXED — `yo-self/codegen/functions/collection.yo` (method-call collection)
**Flips:** `tests/forward_ref_self_method.test.yo` (red → 2/2)
**Class:** codegen collection gap (static-receiver type id). NOT Gap-6.

## Symptom

`s2 test tests/forward_ref_self_method.test.yo`:

```
tests/.yo_selftest_batch_1.bin.c:5032:10: error: call to undeclared function
'yo_id_5000'; ISO C99 and later do not support implicit function declarations
 5032 |   return yo_id_5000(n);
```

`yo_id_5000` (the callee `Self.callee`) has NO definition anywhere in the C — only
the call site. The forward-referenced static method was never collected/emitted.

Repro (the test):

```rust
P :: struct(x : i32);
impl(
  P,
  caller : (fn(n : i32) -> i32)(Self.callee(n)),   // caller BEFORE callee
  callee : (fn(n : i32) -> i32)(n + i32(1))
);
```

`P.caller` is collected (it's called in the test); collection then walks its body
to transitively collect callees. `Self.callee(n)` is the call that must pull in
`callee` — but it didn't. (Also hits `N.is_even_static` ↔ `is_odd_static` mutual
recursion in the same file.)

## Root cause

The collection walker (`find_function_calls_in_expr`) resolves a method call
`recv.method(...)` by looking the method up in the type-trait-methods registry
keyed by `type_id_or_empty(recv_ty)` + method name (the dot-access sub-expr has no
ExprInfo, so the direct ExprInfo-value path can't find it). `recv_ty` is the type
of the receiver EXPRESSION.

For a **static** receiver (`Self.callee` / `P.method`, no instance) the receiver
evaluates to a **TypeValue**, so `recv_ty` is the metatype `Type` — NOT the
receiver type `P`. `type_id_or_empty(Type)` therefore doesn't yield P's id, the
registry lookup misses P's static methods, and `callee` stays uncollected.
(Instance calls `recv.method` work because `recv_ty` IS the instance's type.)

TS collects the type directly whenever an expr's value is a TypeValue
(`collectRequiredFunctions`: `if (isTypeValue(expr.$?.value)) collectType(...)`,
collection.ts:615), which pulls the type's methods in.

## Fix

In the method-call block, prefer the id of the type WRAPPED in the receiver's
`TypeVal` value over `type_id_or_empty(recv_ty)`:

```rust
recv_static_id := match(cdot_args.get(usize(0)),
  .Some(r) => match(expr_info_table_get(info, ast_expr_id(r)),
    .Some(ri) => match(ri.value,
      .Some(rv) => match(rv, .TypeVal(t) => type_id_or_empty(t), _ => String.from("")),
      .None => String.from("")),
    .None => String.from("")),
  .None => String.from(""));
ctid := if(recv_static_id.len() > usize(0), recv_static_id, type_id_or_empty(recv_ty));
```

Additive: only changes `ctid` when the receiver is a TypeValue (a static call);
instance calls are untouched.

## Regression surface

The collection walker runs for every call in every collected function. The change
is gated to TypeVal receivers, so non-static calls are unaffected. Gate: corpus
135/2/0, std 153/153, fixpoint HOLDS, target + prior flips.
