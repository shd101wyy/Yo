# `a == b` on a type with no `Eq` impl silently evaluates to `unit` instead of erroring

**Status: OPEN.** **Class**: wrong-value / api-lie — a comparison that has no
implementation is accepted, prints `()`, and in one position is reported as an
"internal compiler error … please report it" against the user's own type error.

**Found**: 2026-09-04, measuring the `net` row of the std API audit. It is the
mechanism that makes
`issues/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`
silent, but it reproduces standalone with no derive and no `Array` in sight.

## Symptom

Three positions, three different wrong behaviours, one cause.

**1. A unit-accepting position — accepted, prints `()`.**

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

NoEq :: struct(x : i32);

main :: (fn() -> unit)({
  a := NoEq(x : i32(1));
  b := NoEq(x : i32(2));
  s := Array(u16, usize(4)).fill(u16(0));
  t := Array(u16, usize(4)).fill(u16(0));
  println(`struct  == : ${a == b}`);
  println(`array   == : ${s == t}`);
});
export(main);
```

```
$ yo compile noeq.yo --std-path ./std --optimize 2 -o noeq.out && ./noeq.out
struct  == : ()
array   == : ()
```

Expected: `No matching call found for operator "==" with receiver type
"NoEq"`. Neither `NoEq` nor `Array(u16, 4)` has an `Eq` impl —
`std/prelude.yo:5695-5698` gives `Array(T, U)` only `Send`, `Acyclic`,
`Comptime` and `Runtime`.

**2. As a `cond` condition — `yo check` passes, `yo compile` blames itself.**

```rust
  cond((a == b) => { unsafe(printf("eq\n")); }, true => { unsafe(printf("ne\n")); });
```

```
$ yo check noeq3.yo --std-path ./std
check: noeq3.yo — evaluator OK

$ yo compile noeq3.yo --std-path ./std --optimize 2 -o noeq3.out
yo: error: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

The program has an ordinary type error and the compiler tells the user to file
a compiler bug.

**3. Statement position — same ICE.** `(a == b);` on its own line passes
`yo check` and produces the identical "internal compiler error" from
`yo compile`.

The one position that behaves is a `bool`-typed binding, where the unit is
caught downstream by the ordinary type check:

```
error[E0601]: Incompatible types:
- Expected: bool
- Given   : unit
  --> noeq2.yo:9:4
  |
9 |   (r : bool) = (a == b);
```

That diagnostic is honest about the type but still names the wrong problem —
the defect is the missing `Eq` impl, not a `unit` that appeared from nowhere.

## Root cause

`src/evaluator/calls/function.yo:2716-2783`, the infix-operator → trait-method
dispatch. It looks the operator up on the receiver:

```rust
op_methods := get_receiver_methods_by_name_from_env(env, op_name.clone(), receiver_ty, true);
```

and when the lookup finds nothing it throws only for a narrow set of receivers
(`:2771-2780`):

```rust
if((op_methods.len() == usize(0)) && ((is_primitive_type(receiver_ty) && !(is_unit_type(receiver_ty))) || is_type_hierarchy_type(receiver_ty)), {
  exn.throw(dyn(format_error_message(ast_expr_token(expr),
    `No matching call found for operator "${op_name}" with receiver type "${type_to_string(receiver_ty)}"`)));
});
```

A user struct, a user enum and `Array(T, N)` are none of `is_primitive_type`,
`is_unit_type` or `is_type_hierarchy_type`, so they fall through to the soft
callee-atom path and the whole operator call evaluates to `unit`.

The narrow scoping was deliberate, and the comment above the gate records the
measurement behind it: across `check ./std` (153 files) the fall-through fires
8 times, with the receiver being `unit` (5), a bare `SomeT` (2) or an anonymous
struct (1) — never a primitive. The gate was therefore opened only as far as
the evidence went. What that measurement did not cover is a CONCRETE NOMINAL
receiver, which is exactly the case here and which cannot legitimately need the
soft path: if a named struct/enum/`Array` type has no `==`, that is a fact
known at the call site, not a deferred generic question.

Downstream, the `unit` result is what makes higher-level failures silent:
`__derive_eq`'s generated `&&` chain receives a `unit`, reports "Expected bool
type for \"and\" argument", the def-time trial swallows it, and the enclosing
function becomes an `abort()` stub.

## Fix

Widen the hard-error gate at `src/evaluator/calls/function.yo:2771` from
"primitive or type-hierarchy" to "primitive, type-hierarchy, or a CONCRETE
NOMINAL type" — a named struct, a named enum, a `ref` struct and `Array(T, N)`
with a resolved length. Keep the three shapes the existing comment names as
deliberate fall-throughs (`unit`, a bare unresolved `SomeT`, an anonymous
struct), because those are the generic/def-time contexts where the receiver
type is not yet known.

Two things must go with it:

- **An over-rejection canary per exempt shape.** Add a test that a generic body
  comparing two values of an unresolved `SomeT` still type-checks, and one that
  an anonymous-struct receiver still falls through. Widening a rejection
  without those is how a gate change goes green over the cases it broke.
- **Do not settle for the downstream `E0601`.** Reporting `Expected bool, Given
  unit` at the binding is not a fix: it names the symptom, and it does not fire
  at all in positions 1-3 above.

The `cond`-condition and statement-position ICE (symptoms 2 and 3) then
disappear on their own — those are `__yo_user_main` carrying a "Failed to
transpile" marker (`src/codegen/functions/generation.yo:790-795`) because the
evaluator handed codegen a `unit` where a `bool` was needed.

## Breaking change

Yes, in the sense that programs which compile today will start failing —
specifically any program comparing values of a type with no `Eq` impl in a
unit-accepting position. Every such comparison is meaningless today (it
computes nothing and yields `()`), so the break is the point, but it must be
called out in the release notes.

## Regression test

`tests/comptime.test.yo` already owns the `comptime_expect_error` idiom used
for the sibling primitive/`TypeUni` gates (see
`issues/fixed/yo-self-cee-in-function-body.md`), so the rejections belong
beside them:

- `NoEq :: struct(x : i32)` compared with `==`, `!=`, `<` in each of the four
  positions above — string interpolation, `cond` condition, statement, and a
  `bool`-typed binding — must all be compile errors naming the operator and the
  receiver type.
- `Array(u16, usize(4)) == Array(u16, usize(4))` must be a compile error until
  the `Array` `Eq` impl lands (and must then start passing, which makes this
  the shared test with
  `issues/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`).
- The two over-rejection canaries above.
