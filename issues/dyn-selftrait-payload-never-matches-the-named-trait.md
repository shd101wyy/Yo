# `Dyn(SelfTrait)` produces a type no `Dyn(Trait)` accepts — `Error.source()`'s payload cannot be bound, passed or re-thrown

**Status:** OPEN
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit
(the row's third item is "`Error.source` actually used for chaining"; the walk
does not type-check).
**Severity:** api-lie. The declared feature is unusable: `source()` returns a
`Dyn` that is not assignable to `AnyError`, so no chain can be walked. Loud
(a type error), but it points at the user's code, not at the defect.

## Symptom

`std/error.yo:11` declares

```rust
Error :: trait(
  (source : (fn(inout(self) : Self) -> Option(Dyn(SelfTrait)))) ?= (self -> .None),
  where(Self <: ToString)
);
AnyError :: Dyn(Error);
```

`source()`'s payload is documented and intended to BE an `AnyError`. It is not.
Six lines, std only:

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

main :: (fn(io : Io) -> unit)({
  (e : AnyError) = dyn(`disk full`);
  match(e.source(), .Some(s) => { (x : AnyError) = s; println(`${x}`); }, .None => println(`no source`));
});
export(main);
```

```
error[E0601]: Incompatible types:
- Expected: dyn(Error + ToString)
- Given   : dyn((source : fn(self : Self : (ToString)) -> <enum:enum_yo_id_6904>) + ToString)
  --> d3d.yo:7:36
  |
7 |   match(e.source(), .Some(s) => { (x : AnyError) = s; println(`${x}`); }, .None => println(`no source`));
  |                                    ^
```

Passing it to a parameter fails the same way (this is the shape a recursive
chain walk needs):

```rust
Context :: ref(struct(message : String, cause : AnyError));
impl(Context, ToString(to_string : (fn(inout(self) : Self) -> String)(`${self.message}: ${self.cause}`)));
impl(Context, Error(source : (fn(inout(self) : Self) -> Option(AnyError))(Option(AnyError).Some(self.cause))));

handle :: (fn(err : AnyError) -> unit)(println(`handled: ${err}`));
…
match(outer.source(), .Some(s) => handle(s), .None => println(`no source`));
```

```
error: Cannot unify incompatible types:
Expected: "dyn(Error + ToString)"
Given: "dyn((source : fn(self : Self : (ToString)) -> <enum:enum_yo_id_6904>) + ToString)"
```

What DOES work on the payload is anything that only needs "is a Dyn": printing
(`${s}`) and `downcast(s, T)`. Verified end-to-end — the same `Context` wrapper
compiles and runs, printing `saving config: disk full`, `source: disk full`,
`msg=disk full` — so the shallow half of a `wrap`/`context` API is available
today and only the WALK is blocked.

This is not std-specific. Any user trait that uses `Dyn(SelfTrait)` hits it:

```rust
Node :: trait(
  (parent : (fn(inout(self) : Self) -> Option(Dyn(SelfTrait)))) ?= (self -> .None),
  where(Self <: ToString)
);
AnyNode :: Dyn(Node);
…
match(n.parent(), .Some(p) => { (q : AnyNode) = p; println(`${q}`); }, .None => println(`root`));
```

```
error[E0601]: Incompatible types:
- Expected: dyn(Node + ToString)
- Given   : dyn((parent : fn(self : Self : (ToString)) -> <enum:enum_yo_id_7475>) + ToString)
```

## Root cause — the in-body `SelfTrait` is the trait BEFORE it is named, and trait compatibility is by NAME

Three facts compose:

1. A trait type is built with an EMPTY name. `evaluate_trait_type`
   (`src/evaluator/types/trait.yo:1056`):

   ```rust
   // (yo-self: trait name is set externally via variable binding, not embedded in the trait expr)
   trait_name_str := String.from("");
   ```

   and the `TraitT` is constructed from it at `:1066-1078` with a freshly minted
   `trait_id`.

2. `SelfTrait` inside the body resolves to exactly that unnamed value:
   `ctx.self_trait_type` is set to `trait_ty` around every member evaluation
   (`src/evaluator/types/trait.yo:741`, `:799`, `:887`) and the identifier reads
   it verbatim (`src/evaluator/exprs/identifer_and_operator.yo:167-175`). So
   `Dyn(SelfTrait)` in `source`'s return type embeds a `TraitT` whose `name` is
   `""`.

3. The name is stamped on LATER, into a NEW value. `Error :: trait(...)`'s
   binding rebuilds the `TraitT` with the binding name
   (`src/evaluator/exprs/initialization_assignment.yo:542-546`):

   ```rust
   .TraitT(tr_name, tr_atns, tr_fls, tr_fts, tr_id, tr_conc, tr_sc, tr_nsc, tr_atcl, tr_atct) => cond(
     (tr_name.len() == usize(0)) => Option(TypeValue).Some(
       TypeValue.TraitT(binding_name, tr_atns, tr_fls, tr_fts, tr_id, tr_conc, tr_sc, tr_nsc, tr_atcl, tr_atct)
     ),
   ```

   The comment above it claims "Identity is unaffected — trait matching keys on
   the `id` field, which is preserved." That is true of the trait REGISTRY, and
   false of type compatibility, which is where this bug lives:

   ```rust
   // src/types/compatibility.yo:999-1003
   // TraitT: nominal comparison; FnTraitT/FutureTraitT: structural
   .TraitT(name : aname) => match(
     expected,
     .TraitT(name : ename) => (aname == ename),
     _ => false
   ),
   ```

So `AnyError = Dyn(Error)` carries the trait named `"Error"`; `Dyn(SelfTrait)`
carries the same trait (same `id`, same field lists — they share the ArrayLists)
named `""`. The `DynT` rule (`src/types/compatibility.yo:1129-1169`) requires
every expected required-trait to be compatible with some actual one, the
`TraitT` compare is `"" == "Error"` → false, and the two `Dyn`s are declared
incompatible. `ToString` matches on both sides because it is named on both.

This is the same name-vs-id family as
`issues/fixed/yo-self-trait-identity-soundness.md`, which switched
`is_type_registered_as_trait` to id-comparison (and records that TS compares
trait types by `id`, `compatibility.ts:543-549`) but left
`are_types_compatible`'s `TraitT` arm name-based.

## Why the coverage missed it

`source` is read in exactly two places in the tree, and both only exercise the
`.None` default: `tests/error.test.yo:22-29` ("Test Error source returns None by
default") and `tests/codegen-bootstrap/dyn_error_source_default.yo:17`, which
binds the payload as `_`. No `.Some` payload has ever been bound to anything.
`plans/reference/ERROR_TRAIT_AND_TYPEID.md`'s own §6 usage example
(`match(err.source(), .Some(inner) => handle_error(inner), …)` with
`handle_error : (fn(err : AnyError) -> unit)`) does not compile and never did.

## Fix

Preferred: make `are_types_compatible`'s `TraitT` arm identity-based, accepting
an `id` match in addition to the current name match
(`src/types/compatibility.yo:999-1003`):

```rust
.TraitT(name : aname, id : aid) => match(
  expected,
  .TraitT(name : ename, id : eid) => (((aid.len() > usize(0)) && (aid == eid)) || (aname == ename)),
  _ => false
),
```

The `id` is preserved through the naming stamp (point 3 above), so this makes
`Dyn(SelfTrait)` and `Dyn(Error)` the same type without touching trait
construction. Corroborating evidence that the two are already the same trait on
every other path: the impl-side member check ACCEPTS
`impl(Context, Error(source : (fn(inout(self) : Self) -> Option(AnyError))(…)))`
against a trait member declared `-> Option(Dyn(SelfTrait))` — that program
compiles and runs; only reading the result back out fails. It is strictly MORE permissive than today, so it cannot cause a
new rejection — the risk is only over-acceptance, and ids are unique per trait
definition.

Note the leftover name-based hazard while you are there (out of scope for this
fix, worth a follow-up): with the `||` above, two DIFFERENT nameless traits still
compare compatible via `"" == ""`, which is the collision
`issues/fixed/yo-self-trait-identity-soundness.md` removed from the registry
path. Tightening that is a new rejection and needs its own canary sweep.

Alternative (rejected as the primary fix): give the trait its binding name
BEFORE the body is evaluated, so `SelfTrait` snapshots a named trait. The name is
not known at `evaluate_trait_type` time — it comes from the binding — so this
means threading an expected-name down from `initialization_assignment.yo`, which
is a bigger, more invasive change and still leaves compatibility comparing by a
mutable display attribute.

## Regression test

`tests/error.test.yo`, a new test alongside the `.None`-default one, RED before
the fix with the exact `Incompatible types` text above. It must:

1. build a two-deep chain (`wrap`-style `ref(struct(message, cause : AnyError))`
   whose `source` returns `Option(AnyError).Some(self.cause)`);
2. BIND the payload — `(x : AnyError) = s`;
3. PASS it to a `(fn(err : AnyError) -> unit)` parameter;
4. re-`throw` it through an `Exception`;
5. walk to the root and assert the root's text.

Add a user-trait mirror in `tests/dyn.test.yo` (a `Dyn(SelfTrait)`-returning
method on a non-`Error` trait), since the defect is in trait typing, not std.

Gates: `yo check ./std` and `yo check ./src` — `Error` is the tree's only
`SelfTrait` user, but the change touches every trait-vs-trait comparison.

## Not a breaking change

Purely additive acceptance; no program that compiles today stops compiling.
