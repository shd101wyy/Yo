# Position: Yo will NOT support runtime dependent types

**Status: DECIDED 2026-07-24.** This is a position document, not a feature
plan — it records a boundary so future feature requests and verification
design work start from a settled baseline.

## The decision

Yo commits to a **two-layer story** for type/value dependency:

- **Layer 1 — comptime dependency (exists today):** types may depend on
  values, but only on _compile-time-known_ values.
- **Layer 2 — SMT-backed refinements (planned):** properties of _runtime_
  values are expressed as verification clauses (`requires` / `ensures` /
  invariants with `forall` / `exists` quantifiers — see
  `plans/FORALL_TO_GENERIC.md`), checked by a Dafny-style verifier, not by
  the type checker.

**Full (runtime) dependent types — types computed from runtime values, with
definitional equality, normalization, and universes in the core — are an
explicit permanent non-goal.**

## What Yo already has: the cheap half of dependent types

Types in Yo are first-class **comptime values**. This is a Π-type system
whose dependency is staged to compile time (the Zig model):

```rust
// A type constructor IS a comptime function returning a Type.
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(first : A, second : B)
);

// Types depending on VALUES — as long as the value is comptime-known.
Buf :: Array(u8, 24);          // length-indexed array
Matrix :: (fn(comptime(R) : usize, comptime(C) : usize) -> comptime(Type))(
  struct(data : Array(Array(f64, C), R))
);
```

This already delivers most of what "dependent types" are reached for:
length-indexed collections, type-level configuration, GADT-style indexed
enums (`docs/en-US/GADTS.md`), units-of-measure via phantom parameters —
all monomorphized to plain C. CTFE is the evaluation engine; no new theory
is needed to deepen this layer.

## What the verifier layer will cover: the runtime half

The remaining demand — "this index is in bounds", "these two lengths are
equal", "this list is sorted", "this handle is not closed" — is
**refinement**, not dependency. The planned Dafny-style clauses cover it:

```rust
// Sketch (final syntax belongs to plans/VERIFICATION.md, not this doc):
get :: (fn(generic(T), self : Vec(T), i : usize) -> T)(
  requires(i < self.len()),
  ...
);
concat :: (fn(a : Vec(T), b : Vec(T)) -> Vec(T))(
  ensures(result.len() == (a.len() + b.len())),
  ...
);
```

Refinements read like types (attached to signatures) but are discharged by
an SMT solver: checking stays decidable, inference stays intact, and errors
stay explainable ("could not prove `i < self.len()` at call site X" instead
of a failed higher-order unification trace). This is the explicit lesson of
the Dafny / Liquid Haskell / F\* lineage: for a systems language,
verification layered OVER a simple type system beats verification baked
INTO the type system.

## Why full dependent types are rejected

1. **Type equality becomes proof search.** With runtime values in types,
   checking `Vec(n + m)` against `Vec(m + n)` requires normalization and
   definitional equality in the checker, a universe hierarchy to stay sound,
   and global inference dies. Empirical evidence from this codebase: the
   Gap-6 campaign (see
   `issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`) — weeks spent
   on _nominal_ struct identity, the TRIVIAL base case of type equality.
   Neither compiler (TS or yo-self) is architected for judgmental equality,
   and dependent types make identity strictly harder than our historically
   hardest bug class.

2. **The C backend model breaks.** Yo's pipeline is
   monomorphize-then-emit-C11. Monomorphization is only possible over
   compile-time-known values; runtime-dependent types require runtime type
   representations or a quantitative erasure analysis (Idris 2's QTT exists
   precisely to solve this). That is a different compiler, not an extension
   of this one.

3. **Interaction costs compound.** Dependent types × algebraic effects is
   open research; dependent types × RC ownership semantics is little better.
   Yo would be composing three hard systems where each pairwise interaction
   is novel territory.

4. **The residue is small.** Programs whose types genuinely must compute
   over runtime values — beyond what staging or refinement can express — are
   the domain of proof assistants (Agda/Lean/Idris), not of a systems
   language with an RC runtime and a C backend.

## The staging test (apply to future feature requests)

Any "we need dependent types for X" request must answer one question:

> **Can the dependency be staged to comptime, or expressed as a refinement
> on runtime values?**

- Matrix dimensions, protocol state machines, units of measure, typed
  indices into fixed layouts → **comptime** (Layer 1).
- Bounds, non-nullness, sortedness, length relationships between runtime
  values, state-machine invariants over runtime state → **refinement**
  (Layer 2).
- Neither → out of scope for Yo, by this position.

## Non-goals (permanent, for the record)

- Universe hierarchies (`Type : Type1 : Type2 …`).
- Propositional/definitional equality types in the core (`Eq(a, b)` as a
  type former with `refl`).
- Type-level computation over runtime values; runtime `Type` values beyond
  the existing reflection surface (`docs/en-US/TYPE_REFLECTION.md`).
- Dependent pattern matching / motive inference.

## Implications for other plans

- `plans/FORALL_TO_GENERIC.md`: the rename frees `forall` / `exists` for the
  Layer-2 quantifiers; this position is the reason Layer 2 gets the
  quantifier vocabulary rather than the type system.
- A future `plans/VERIFICATION.md` owns Layer-2 design (clause syntax, SMT
  encoding, ghost state, termination). It should link back here as its
  scoping charter.
- Layer-1 deepening (richer comptime computation over types, GADT
  refinements during match — `docs/en-US/GADTS.md`) continues freely; it
  needs no new theory and does not move this boundary.
