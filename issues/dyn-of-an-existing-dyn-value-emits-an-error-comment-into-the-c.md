# `dyn(<a Dyn value>)` emits an error COMMENT into the C instead of failing the compile

**Status:** OPEN
**Found:** 2026-09-05, building the over-rejection canary set for
`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md`
(re-boxing an `AnyError` was one of the canary shapes; it turned out never to
have worked).
**Severity:** crash-at-C-compile, with a misleading diagnostic. `yo check` is
clean and the evaluator ACCEPTS the coercion; codegen then writes its refusal
into the output as a C comment, so the failure the user sees is
`error: expected expression` on a line that contains only a comment.

## Symptom

```rust
{ AnyError, Error } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

ValErr :: enum(Boom, Bust);
impl(ValErr, ToString(to_string : (fn(inout(self) : Self) -> String)(match(self, .Boom => `boom`, .Bust => `bust`))));
impl(ValErr, Error());

redyn :: (fn(e : AnyError) -> AnyError)({
  return(dyn(e));
});

main :: (fn(io : Io) -> unit)({
  (r2 : AnyError) = redyn(dyn(ValErr.Boom));
  println(`${r2}`);
});
export(main);
```

`yo check` — clean (rc=0). `yo compile … --optimize 2`:

```
out.c:1814:108: error: expected expression
 1814 |   __yo_t0 _file____User_temp_11393 = /* Error: dyn() requires an object type (use box() for value types) */;
1 error generated.
```

The evaluator's `evaluate_dyn_value` explicitly supports a `DynT` payload — it
is arm 2 of the "Determine the expected DynType" cascade
(`src/evaluator/values/dyn.yo`), and `is_dyn_type(value_type)` is one of the two
conditions that skip the auto-box. So the front end says yes and only
`generate_dyn_call` says no.

The message is also wrong twice over: the payload here is not a value type, and
`box()`ing a `Dyn` is not what the user wants.

## Root cause

`generate_dyn_call` (`src/codegen/exprs/dyn.yo`) reaches its
"requires an object type" fallback for a `DynT` operand: a Dyn value is a
two-word fat pointer `{ data, vtable }`, not a `void*`, so neither the object
path (`__yo_incr_rc((void*)…)`) nor the boxed-value path applies, and no arm
handles "the payload is already a Dyn". TS's `evaluateDynValue` leaves the same
question open — `values/dyn.ts:546` carries the literal comment *"QUESTION:
Should we allow to assign DynType to another DynType with superset of traits?"*

## Decide, then implement one of

1. **Support it** — a `dyn(d)` where `d : Dyn(A)` and the target is `Dyn(B)`
   with `B ⊆ A` is a widening: reuse `d.data`, and select (or synthesize) the
   vtable for `B`. This needs a per-(concrete, Dyn-type) vtable, which the
   `dyn_impls` registry already keys that way.
2. **Reject it in the evaluator** — remove the `DynT` arm from the dyn-type
   cascade and throw at the `dyn(...)` token
   ("`X` is already a `Dyn`; pass it directly"). Cheap, honest, and it is what
   today's behaviour amounts to.

Either way, codegen must not write an `/* Error: … */` comment into an
expression position. Route it through `codegen_fatal_expr` like the other
unreachable codegen paths so the compiler reports the error itself.

## Regression test

`tests/dyn.test.yo`: `comptime_expect_error` on the re-dyn if option 2 is taken,
or a round-trip assertion through the widened Dyn if option 1 is.
