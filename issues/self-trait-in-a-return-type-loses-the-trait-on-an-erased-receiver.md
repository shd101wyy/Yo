# `Dyn(SelfTrait)` in a return type resolves WITHOUT the trait when called on an erased receiver, so `Error.source` cannot be chained

**Status: OPEN.** Found 2026-09-09 while implementing `ErrorChain` /
`root_cause` for §4's Error-ergonomics row, which this blocks.

## Reproducer

`issues/repros/error-source-does-not-unify-with-anyerror.yo`:

```rust
{ Error, AnyError, Context } :: import("std/error");
Inner :: enum(Boom);
derive(Inner, Error(.Boom => `boom`));

walk :: (fn(err : AnyError) -> unit)({
  (cur : AnyError) = err;
  // `source()` is declared `fn(inout(self) : Self) -> Option(Dyn(SelfTrait))`.
  // On a Dyn(Error) receiver its result will not assign back into AnyError.
  match(cur.source(), .Some(next) => { cur = next; }, .None => ());
});
```

```
error[E0601]: Incompatible types:
- Expected: dyn(Error + ToString)
- Given   : dyn((source : fn(self : Self : (ToString)) -> Option(dyn( + ToString))) + ToString)
```

Read the Given carefully — there are TWO levels of the same defect:

1. The outer `Dyn` lists the trait **structurally**, as its member signature
   (`source : fn(...) -> ...`), instead of by the name `Error`. So it will not
   unify with `dyn(Error + ToString)` even though it describes the same trait.
2. Inside that signature, the nested `Dyn(SelfTrait)` is `dyn( + ToString)` —
   trait list EMPTY, where-bound (`ToString`) intact.

Inside `std/error.yo` itself the outer level is already resolved, so only (2)
shows and the message is the shorter
`Expected: Option(dyn(Error + ToString)) / Given: Option(dyn( + ToString))`.

## What works, and what does not

Calling a method ON the result is fine — `cur.source()` then
`.to_string()` on the payload runs correctly, and prints the chain:

```
source = boom
top = while loading: boom
```

So the vtable dispatch and the value are right. Only the STATIC TYPE is wrong,
and it is wrong in the one way that matters: `Option(dyn( + ToString))` will
not unify with `Option(AnyError)`, so the result cannot be stored, re-erased,
passed to `downcast`/`error_is`, or yielded as an `Iterator.Item`.

Also required, and not a route around it: the receiver must be ANNOTATED. A
bare `dyn(x)` with no target type has no known `Dyn` and none of its methods
resolve at all ("No matching call found"). That is a separate, milder trap —
annotate and it is fine.

## Root cause

`SelfTrait` resolves from `ctx.self_trait_type`, the trait CURRENTLY BEING
DEFINED (`src/evaluator/exprs/identifer_and_operator.yo:196`). The `?=` default
for `source` is registered while `Error`'s TraitT is still under construction,
so the `Dyn` it builds captures whatever the trait is AT THAT MOMENT — an
identity-less structural description, with the not-yet-populated member list
showing as an empty trait list at the nested level. The where-bound is attached
separately, which is why it survives at both levels and makes the two halves of
the type look inconsistent.

`src/types/substitution.yo:27` already documents that this method makes the
graph cyclic (`DynT → TraitT → … → DynT`) and guards `substitute` against
re-descending by trait `id`. So the cycle is known and handled; what is not
handled is that the Dyn captured the trait's member list rather than a
reference resolved after the trait completes.

**Writing the trait's own name instead does not work** — `SelfTrait` is the
only spelling available:

```rust
(source : (fn(inout(self) : Self) -> Option(Dyn(Error)))) ?= (self -> .None),
// error: Failed to evaluate argument 1 of 'Dyn' expression.
```

`Error` is not yet bound inside its own definition.

## Fix sketch

Make the `Dyn` hold the trait BY REFERENCE (its `id`, resolved on demand)
rather than by a snapshot of its trait list taken at construction, so a
`Dyn(SelfTrait)` in a trait member's signature denotes the completed trait.
The cycle guard in `substitution.yo` already keys on trait `id`, so the
identity needed for this is present.

A narrower alternative: after a trait's TypeValue is complete, rewrite any
`Dyn` in its member signatures whose trait list is empty to point at it. That
is more surgical but leaves the general defect in place for any other
self-referential `Dyn` position.

## What it blocks

`ErrorChain` (an `Iterator` over `source`) and `root_cause` — both must store
the result of `source()` as an `AnyError`. Rust's `Error::sources()` and
`anyhow::root_cause` are the shapes wanted. Until this is fixed, a caller can
only follow ONE link, and only to render it, never to test or re-throw it.
Recorded against the Core row in `plans/STD_API_STABILIZATION.md`.
