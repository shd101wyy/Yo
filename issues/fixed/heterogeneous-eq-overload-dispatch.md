# Heterogeneous trait-method overloads: two dispatch bugs (FIXED)

**Status: FIXED.** Unblocked `plans/archive/SLICE_REWORK.md` step 1 (`String == str`,
`StrPattern`). Regression tests: `tests/impl.test.yo` ("heterogeneous
trait-method overload dispatch", "trait-impl body delegating to a same-name
inherent overload") and `tests/string/string.test.yo` (String↔str Eq +
StrPattern blocks).

## Bug 1 — specializedType mixes impl AST with trait env

### Minimal repro (user file, TS compiler)

```rust
W :: struct(v : i32);
impl(
  W,
  Eq(str)(
    (==) : (fn(self : Self, other : str) -> bool)((other.len() == usize(3)))
  )
);
t :: (fn(w : W) -> bool)((w == "abc"));   // ← failed: Variable "str" not found
```

The impl registered fine; the **call site** failed. The error blamed the
impl's `other : str` annotation.

### Root cause

`tryToImplementTraitWithArgumentsByTraitType`
(`src/evaluator/calls/trait-type.ts`) built the registered method's
`specializedType` as:

```ts
argValue.specializedType = {
  ...traitFieldType, // env = TRAIT's definition env
  parameters: argValue.type.parameters, // exprs = IMPL's annotation ASTs
  parametersFrame: argValue.type.parametersFrame,
};
```

`traitFieldType.env` is the env captured inside the trait constructor call —
for the prelude's `Eq` (line ~634) that snapshot predates `str` (defined at
~5824), and never contains impl-site names. At the call site,
`evaluateFunctionParameterTypeAgain` re-evaluates each parameter's
`exprs.typeExpr` in `functionType.env` — the impl's `str` AST in the trait's
env → "Variable str not found", the overload never materializes, dispatch
offers only the homogeneous one.

Every pre-existing impl annotated parameters as `Self` (resolved specially
via `context.SelfType`, never env lookup), which is why this never fired
before.

### Fix

Keep the parameter **labels and metadata** from the impl's type (the body
uses those names) but take each parameter's **type and type exprs from
`traitFieldType`** — `Self`/`Rhs` ASTs that are self-consistent with the
trait env the specializedType carries (`Rhs` is bound in that env by the
trait-constructor call).

This also fixed the secondary symptom: with two overloads registered,
the `Eq` trait's `?=` default for `(!=)`
(`not(Self.(==)(lhs, rhs))`) now binds the right overload by argument
types, so impls only need to provide `(==)`.

## Bug 2 — direct-method lookup shadows overloads during impl registration

### Minimal repro

```rust
V :: struct(n : i32);
PickStr :: trait(pick : (fn(self : Self, x : str) -> i32));
impl(V, pick : (fn(self : Self, x : V) -> i32)(i32(1)));
impl(
  V,
  PickStr(
    pick : (fn(self : Self, x : str) -> i32)((self.pick(self) + i32(1)))
    //                                         ^ failed: "Cannot unify str and V"
  )
);
```

### Root cause

During registration, `tryToImplementTraitWithArgumentsByTraitType` splices
the in-progress trait's fields into `receiverType.trait.fields` **ahead of**
the existing ones (so siblings/`Self.X` resolve). But
`getReceiverMethodsByNameFromEnv` (`src/env.ts`) looked up direct methods
with `.find` — first name match only. The in-progress `pick(str)` shadowed
the inherent `pick(V)`; dispatch got exactly one candidate and the unify
failure was fatal (single-candidate calls skip the checking phase).
After registration the impl lives as an empty-label TraitValue field which a
separate loop collects alongside the direct field — which is why the same
call worked at module level but not inside the impl body.

### Fix

Both direct-method lookups in `getReceiverMethodsByNameFromEnv` now
`.filter` and push **all** same-name function-typed fields as candidates.

## yo-self parity

yo-self stores trait methods in a module-level registry
(`get_type_trait_methods_by_name`) that already returns ALL same-name
methods, and its trait-type call path never builds a `specializedType` —
neither bug exists there. Verified: yo-self-bin `check ./std` passes 151/151
with the new `Eq(str)`/`Eq(String)`/`StrPattern` impls in
`std/string/string.yo`.
