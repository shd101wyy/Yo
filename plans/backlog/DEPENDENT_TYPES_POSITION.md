# Position: Yo will NOT support runtime dependent types

**Status: DECIDED 2026-07-24; re-audited against ATS 2026-09-30 and
against F\* 2026-10-14, upheld both times.**
This is a position document, not a feature plan — it records a boundary so
future feature requests and verification design work start from a settled
baseline. The 2026-09-30 audit (ATS/DML-style indexed types, refinements,
type erasure, existentials) is `ATS_STYLE_INDEXED_TYPES.md`; its verdict is
summarized in the section "The ATS question" below. The 2026-10-14 audit
(F\*'s dependent core, refinement types, erasure, effects and tactics) is
`FSTAR_ADOPTION_CANDIDATES.md`; its verdict is "The F\* question" below.

## The decision

Yo commits to a **two-layer story** for type/value dependency:

- **Layer 1 — comptime dependency (exists today):** types may depend on
  values, but only on _compile-time-known_ values.
- **Layer 2 — SMT-backed refinements (landed: `FORMAL_VERIFICATION.md`
  V1–V7):** properties of _runtime_ values are expressed as verification
  clauses (`requires` / `ensures` / `invariant` / `decreases`, `ghost`,
  `forall` / `exists` — see `plans/archive/FORALL_TO_GENERIC.md`) and as
  erased refinement types (`refine(T, p)`, `std/spec/`), checked by a
  Dafny-style Z3-backed verifier, not by the type checker.

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
   `issues/retired/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`) — weeks spent
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

## The ATS question (audited 2026-09-30)

ATS compiles to C and advertises dependent types, refinement types and type
erasure, so the obvious challenge to this position is "ATS does it; why not
Yo?". The audit (`ATS_STYLE_INDEXED_TYPES.md`) answers it in three parts.

**ATS does not have what this document rejects.** Its "dependent types" are
Dependent ML's *indexed types*: types indexed by terms of a separate,
decidable statics language (`int`, `bool`, `addr`, …), with `{n:nat}` /
`[n:nat]` binders on signatures, subset sorts (`{a:int | a >= 0}`), and a
constraint solver that discharges the arithmetic at type-checking time —
built-in for linear arithmetic, Z3 via `--constraint-export` for the rest.
Indices, binders and proof terms are erased before C. There is no
definitional equality over program terms, no universe hierarchy, no type
computed from a runtime value: the statics never touch the dynamics. The
four reasons below reject *runtime-valued types with a judgmental-equality
checker*; ATS is not a counter-example to them.

**What ATS has, Yo has, in two layers rather than one.** With erasure, an
indexed type `list(a, n)` is the refinement `{xs : list(a) | len(xs) = n}`
(the liquid-types reading of DML), so every ATS index statement is a Yo
contract: `{m,n} (list(m), list(n)) -> list(m+n)` is
`ensures(r.len() == (a.len() + b.len()))`; `{i | i < n}` is
`requires(i < xs.len())`; `sortdef nat` is `refine(T, p)`. Comptime indices
(`Array(T, N)`, `generic(N : usize)`) cover the cases where the index really
is a constant. ATS's `[n]` index existential is Yo's ordinary runtime value
with a ghost witness; its packed type existential is `Dyn(Trait)`; its
opaque one is `Impl(Trait)`. Constructor existentials (`Wrap(generic(T),
value : T, …)`) remain a non-goal — `Dyn` is their lowering.

**What Yo lacks is a verifier subset, not a type former.** The verifier
models fixed-length `Array(T, N)` and integers; an `ArrayList(T)` parameter
is "outside the integer/bool/array subset" (measured), so the length
contracts above can be *stated* but not *discharged*. That is the work
(`ATS_STYLE_INDEXED_TYPES.md` R1), and it is verifier work. Bringing ATS's
*notation* into the checker — index sorts, symbolic `{n}` binders that
compile to one C function while `generic(N : usize)` compiles to one per
`N`, constraints generated during unification, Z3 inside `yo check` — is
rejected for Yo-specific reasons listed there (§4, §6): a second kind of
generic parameter with the opposite specialization rule, a new
type-variable kind the soundness campaign has asked nobody to add before an
identity design exists, and the reversal of the verifier's
separate-pass architecture.

## The F\* question (audited 2026-10-14)

F\* is a full dependent type theory that compiles verified code to C
(Low\*/KaRaMeL: HACL\*, EverParse), so the second obvious challenge is "F\*
supports dependent types and ships C; why not Yo?". The audit
(`FSTAR_ADOPTION_CANDIDATES.md` §3) answers it in three parts.

**F\* pays the costs this document names, and says so.** Its tutorial
states that type checking "is undecidable in general", that a refinement
check "trusts the encoding and Z3", and that "without the stratification
of universes, F\* would be unsound". The surface its users tune — `fuel`,
explicit `:pattern` triggers on every quantifier, `opaque_to_smt`, hint
files so proofs survive the next Z3 — is the engineering that keeps an
SMT skeleton stable under a dependent core. F\* is a confirmation of
reasons 1–3 above, not a counter-example to them.

**What F\* ships is Yo's two layers.** The F\* code in production is
Low\*: first-order, with lengths as refined machine integers, contents as
erased ghost sequences, lemmas relating the two, and every index, proof
and ghost field erased before C. The dependent core *states* those; Z3
*checks* them; C types are what *runs*. That is Layer 1 + Layer 2, and
"supporting dependent types like F\* does" means keeping every value
dependency erased and SMT-discharged — the design this document chose.
F\* needs a universe hierarchy because its propositions are types; Yo's
propositions are `bool` in ghost context and a proof is never a value, so
there is nothing to stratify.

**What Yo lacks is pervasiveness, not a type former.** In F\* a refinement
flows through every binder, result and record field, and ghost state can
live inside a runtime value (`erased` fields). In Yo the verifier
consumes a refinement only on function parameters (a local's binder erases
it to the base type and a field's refinement is never read, so neither
carries an obligation), and there is
no ghost field. Closing that (that doc's
F1, F2) is verifier-pass work that leaves unification alone; the rest of
the audit (auto-firing lemmas, hint replay, scoped hiding, fuel, inferred
termination measures, split obligations) is the SMT engineering F\* grew
around its core, and it transfers to a Dafny-shaped verifier unchanged.
Tactics stay a non-goal, with F\*'s own practice as the second reason:
tactics there are preprocessing for the SMT solver, used on the rare
hard assertion, with no interactive mode.

## Non-goals (permanent, for the record)

- Universe hierarchies (`Type : Type1 : Type2 …`).
- Propositional/definitional equality types in the core (`Eq(a, b)` as a
  type former with `refl`).
- Type-level computation over runtime values; runtime `Type` values beyond
  the existing reflection surface (`docs/en-US/TYPE_REFLECTION.md`).
- Dependent pattern matching / motive inference.

## Implications for other plans

- `plans/archive/FORALL_TO_GENERIC.md`: the rename frees `forall` / `exists` for the
  Layer-2 quantifiers; this position is the reason Layer 2 gets the
  quantifier vocabulary rather than the type system.
- `FORMAL_VERIFICATION.md` owns Layer-2 design (clause syntax, SMT
  encoding, ghost state, termination) and links back here as its scoping
  charter.
- `ATS_STYLE_INDEXED_TYPES.md` is the plan for the ATS-shaped work that
  this position permits: a `len` measure for runtime collections in the
  verifier (R1), the lemma layer (R2), computed comptime lengths in
  non-binding positions (I1), and the existentials write-up (E1).
- `FSTAR_ADOPTION_CANDIDATES.md` is the plan for the F\*-shaped work this
  position permits: refinements on binders, results and fields (F1), ghost
  fields and parameters (F2), and the verifier engineering F3–F9.
- Layer-1 deepening (richer comptime computation over types, GADT
  refinements during match — `docs/en-US/GADTS.md`) continues freely; it
  needs no new theory and does not move this boundary.
