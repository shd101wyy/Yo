# A generic bound ONLY by an explicit `comptime(C) : Type` argument leaves the call result under-resolved

**Status:** OPEN
**Found:** 2026-08-24, prototyping `collect` for STD_API_AUDIT D3.4.
**Severity:** high for std design — this is the "trait-generic-method
prototyping" gap the audit named as the reason `collect`/`FromIterator` was
deferred. It blocks every "pass the target type, get a value of it back" API:
`collect(C)`, a `parse(T)`, a `zeroed(T)`.

## Symptom

When a function's type parameter is pinned **only** by the explicit comptime
type argument — no value argument has that type — the call's *result* is
under-resolved. Method calls on the result then fail to resolve, and if the
result is discarded the evaluator accepts the call but codegen emits
"Failed to transpile part of main's body".

An explicit type annotation on the binding does **not** repair it.

## Measured matrix

All four compiled with the same binary, 2026-08-24
(`yo compile <f> --release`; reproducer: `issues/repros/comptime-type-arg-binding.yo`):

| shape | result |
| --- | --- |
| `pick :: (fn(comptime(C) : Type, v : C) -> C)(v)` | ✅ works — C is also pinned by a value argument |
| `a := (i32 <: Default).default()` (concrete type) | ✅ works — explicit trait dispatch is fine |
| `dflt2 :: (fn(comptime(C) : Type, hint : C, where(C <: Default)) -> C)((C <: Default).default())` | ✅ works — adding *any* value parameter of type C fixes it |
| `dflt :: (fn(comptime(C) : Type, where(C <: Default)) -> C)((C <: Default).default())` | ❌ **fails** |

The failing call:

```rust
dflt :: (fn(comptime(C) : Type, where(C <: Default)) -> C)((C <: Default).default());
main :: (fn() -> unit)({
  (a : i32) = dflt(i32);
  println(a.to_string());     // Error: No matching call found with arguments: (a.to_string)()
});
```

and with the result discarded:

```rust
main :: (fn() -> unit)({
  dflt(i32);                  // evaluator accepts …
  println(`ok`);              // … but codegen: "Failed to transpile part of main's body"
});
```

## Reading

The working/failing contrast says the type binding for `C` is populated by
**unifying value arguments against parameter types**, and not by the explicit
comptime `Type` argument itself — even though the caller wrote `i32` in the call.
The body can use `C` (the call is accepted), so `C` reaches the callee's
environment as a *value* binding; what is missing is the *type* binding that the
declared return type `-> C` and the call-site result stamp consult.

Two consequences worth noting for whoever fixes it:

- the binding annotation `(a : i32) = dflt(i32);` does not stamp `a` as `i32` —
  the annotated binding adopts the RHS's (unresolved) type, which is itself
  worth checking.
- the failure is silent-ish at eval time and only becomes loud in codegen when
  the value is used, which is the same late-failure signature as the
  under-resolution family (`issues/varbound-combinator-receiver-impl-match.md`,
  `issues/iterator-chain-shared-stamp-cross-item-pollution.md`) — but the
  trigger here is much simpler and reproduces in three lines, so it may be a
  distinct, more tractable bug.

## ROOT CAUSE (found 2026-08-24)

Not a type-binding bug at all — a **call-routing** bug. Two independent
investigations converged on `src/evaluator/calls/function.yo:5485`, the gate in
`evaluate_function_call`'s FuncVal arm:

```rust
if(((is_type_hierarchy_type(ret_type) || callee_result_is_comptime) || all_args_are_types) || fv_is_macro, {
  … evaluate_comptime_fn_call … return(expr);
})
```

`all_args_are_types` (same file, :5454) is true whenever **every** evaluated
argument holds a `TypeVal`. A function whose only parameter is
`comptime(C) : Type` always satisfies it, so `dflt(i32)` is routed to the CTFE
*type-constructor* path and never reaches `_evaluate_funcval_runtime_call` —
which owns the only channel that ever resolves a return type naming a comptime
parameter (the declared return-type EXPRESSION is re-evaluated in the callee env,
:1974-1993, `hkt=i32` in the `YO_DEBUG_RRE` trace). The CTFE arm's own repair
(:5676) is value-space only and cannot resolve `C`, so the call is stamped with
the raw SomeT (:5758).

The probes that make this decisive:

| probe | shape | result |
| --- | --- | --- |
| `pick(i32, i32(5))` | value param of type C | works |
| `dflt2(i32, i32(0))` | dummy `hint : C` | works |
| **`dflt4(i32, i32(0))`** | dummy `dummy : i32`, **unrelated to C** | **works** |
| `dflt(i32)` | all args are types | fails |

`dflt4` kills the "value arguments unify C" reading outright: an `i32` parameter
that has nothing to do with `C` fixes it, purely by flipping the gate to false.

A second, worse symptom of the same gate:

```rust
d6 :: (fn(comptime(C) : Type) -> i32)({ println(`BODY-RAN`); i32(7) });
d6(i32);   // BODY-RAN prints AT COMPILE TIME, then:
           // "Function body is not evaluated correctly. Expected to return a
           //  compile-time known value."
```

An ordinary runtime function is CTFE-executed because its arguments happen to be
types. Adding one runtime parameter makes it behave normally.

Related, and worth fixing separately: the annotation `(a : i32) = dflt(i32);`
does not repair the call site because the annotated binding **adopts the RHS
type** (`src/evaluator/exprs/assignment.yo:1153`), and the mismatch is not caught
because `are_types_compatible(i32, SomeT C : (Default))` is true — a constrained
SomeT accepts any concrete type satisfying its bounds
(`src/types/compatibility.yo:415`).

## Fix

Route to the type-constructor path when the callee is **declared** to return a
type, rather than when the call's arguments happen to all be types. The two
existing disjuncts already cover constructors whose *recorded* return is bare
`Type` or flagged comptime-only; `all_args_are_types` was added for a
constructor whose recorded return had been specialized to a concrete struct
(see its comment at :5446). That case is better served by consulting the
callee's DECLARED signature (`get_func_type(func_id)`), whose result is
`Type` / comptime-only for every real type constructor, and is `C` or `i32`
for the two broken shapes.

Dropping the disjunct outright is NOT safe: it is what keeps repeat
constructor calls memoized and stamped with `constructor_func_id`, and losing
that fragments type identity — the era-split class fixed in #247.

## Why it matters for std

`collect` cannot be expressed without it. The natural shape is

```rust
collect : (
  fn(
    generic(A : Type),
    self : Self,
    comptime(C) : Type,
    where(Self <: Iterator(Item := A), C <: Default, C <: Extend(A := A))
  ) -> C
)( … )
```

which is exactly the failing shape: `C` is pinned only by the type argument.
Two shapes were ruled out on the way:

- `FromIterator(A)` with a *generic trait method*
  (`from_iter : (fn(generic(I : Type), it : I, where(I <: Iterator(Item := Self.A))) -> Self)`)
  fails earlier, at the bound check itself.
- The same `collect` written as a free function fails the `I <: Iterator(Item := A)`
  bound; as a blanket method on `I <: Iterator` the receiver bound resolves fine,
  which is the shape to keep once this bug is fixed.

Until then, `collect` would have to be a family of concrete methods
(`collect_list`, `collect_set`, …), which the audit's §1 stability contract makes
an expensive thing to ship and later replace.
