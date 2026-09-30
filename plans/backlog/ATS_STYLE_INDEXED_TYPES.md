# ATS-style indexed types, refinements and existentials in Yo — audit and plan

**Status:** BACKLOG — audit done 2026-09-30 (develop `df3798c4a`, seed v0.2.46);
the plan's phases are written, not started. Scoping charter:
[`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md) (updated the same
day with this audit's verdict). Owner of the type-checker half of the
prerequisites: [`../TYPE_SYSTEM_SOUNDNESS.md`](../TYPE_SYSTEM_SOUNDNESS.md);
owner of the verifier half: [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md).

## 0. The verdict in four sentences

1. What ATS calls "dependent types" is **DML-style indexed types**: types
   indexed by terms of a separate, decidable *statics* language, checked by a
   constraint solver, with indices and proofs erased before C. That is not the
   "full dependent types" the position document rejects (runtime values in
   types, definitional equality, universes), so the position does not forbid
   it.
2. Yo already has the two halves ATS's model decomposes into: **comptime
   indices** (`Array(T, N)`, `generic(N : usize)`, monomorphized — §2.1) and
   **erased, Z3-discharged refinements over runtime values**
   (`refine(T, p)`, `requires` / `ensures`, `ghost` — §2.2). An ATS signature
   `{m,n:nat} (list(a,m), list(a,n)) -> list(a,m+n)` is, in Yo,
   `ensures(r.len() == (a.len() + b.len()))`.
3. The one thing Yo cannot do today that ATS does on its first page is
   **reason about the length of a runtime collection**: the verifier models
   only fixed-length `Array(T, N)`, and an `ArrayList(T)` parameter is
   "outside the integer/bool/array subset" (measured, §2.3). That is a
   verifier gap, not a type-system gap, and closing it (§5, R1) is the whole
   substance of "supporting ATS-style dependent types" in Yo.
4. Adding ATS's *notation* — index sorts, `{n}` / `[n]` binders, singleton
   `int(n)`, constraint solving inside unification — is **rejected** (§4): it
   would be a second kind of generic parameter with the opposite
   specialization semantics from `generic(N : usize)`, it needs a new
   type-variable kind the soundness campaign has asked nobody to add before a
   type-variable identity design exists, and it would move the solver from an
   opt-in pass into `yo check` (§6).

## 1. What ATS actually has (the model, not the folklore)

ATS (ATS2 / Postiats) is the direct descendant of Dependent ML (Xi & Pfenning
1999). Its "dependent types" are:

| ATS feature | What it is |
| --- | --- |
| **Statics** | A separate language of *sorts* (`int`, `bool`, `addr`, `type`, `t@ype`, `prop`, `view`, `viewtype`) and static terms over them. Types are indexed by static terms: `list(a, n)`, `int(n)` (the singleton type of the integer `n`), `arrayref(a, n)`. |
| **Quantified index binders** | `{n:nat}` universal ("for all `n`") and `[n:nat]` existential ("for some `n`") on a signature; e.g. `fun length {a:t@ype}{n:nat} (xs : list(a, n)) : int(n)`. |
| **Subset sorts** | `sortdef nat = {a:int | a >= 0}`; `{n:int | n > 0}` — refinements of a sort by a predicate over statics. |
| **Constraint solving** | Type checking *elaborates* the program and emits arithmetic constraints over the statics; a failed constraint is a type error at `patsopt -tc`. The built-in solver handles **linear** integer arithmetic; non-linear constraints need an external solver: `patsopt -tc --constraint-export` writes them as JSON and `patsolve_z3` / `patsolve_smt2` discharge them with Z3. |
| **Proofs** | `prfun` (proof functions), `dataprop` (inductive relations, "like Prolog clauses"), `praxi` (axioms), `$solver_assert`. Proof terms are values classified by props, threaded through the code by hand, and **erased after type checking** — "only the factorial computation code remains". |
| **Erasure** | Statics, index binders and proofs have no runtime representation. `int(n)` is a C `int`; `list(a, n)` is a C list; `[n:nat] list(a, n)` is just a list. |
| **Views / linear types** | `T @ L` at-views and `viewtype`s make memory and resources linear; this is ATS's memory-safety story. |
| **Templates** | `{a:t@ype}` functions are monomorphized per flat type (Yo's model); `{a:type}` (boxed) functions are compiled once because every boxed value has one size. |

The two facts that matter for the comparison:

- **An index is symbolic, not a compile-time constant.** `{n:nat} list(a, n) -> int(n)` compiles to *one* C function; `n` is never evaluated, it is a name the constraint solver reasons about. Yo's `generic(N : usize)` is the opposite: `N` is a comptime *value*, the body is re-evaluated at each `N`, and codegen emits one C function per length.
- **Index equality is constraint entailment.** `list(a, n+1)` matches `list(a, 1+n)` because the solver proves `n+1 = 1+n`; the checker never normalizes terms. This is the "decidable fragment" answer to the position document's reason 1 — and it works only because the statics are a closed, first-order arithmetic language kept apart from the program.

## 2. What Yo has today (measured)

### 2.1 Layer 1 — comptime indices

| Form | Status (develop `df3798c4a`) |
| --- | --- |
| `Array(u8, 5)`, `Array(u8, usize(2) + usize(3))` | works; the length folds at comptime (an untyped `2 + 3` is E0601 `comptime_int` vs `usize`) |
| `generic(N : usize)` as a length binder in parameters and result, `-> Array(u8, N)` | works (`tests/array.test.yo`) |
| `-> Array(u8, T.BYTES)` (a bare associated-constant projection) | works since 2026-09-16 (`VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md` steps 1-2) |
| a COMPUTED length mentioning a binder, `-> Array(u8, N + usize(1))` | **rejected**: "Array length is not a compile-time constant, a bare generic parameter, or an associated constant" (`src/evaluator/types/array.yo`) |
| one `N` bound by two arguments of different lengths | **accepted — soundness hole**, the last argument wins: `issues/fixed/a-usize-generic-binder-rebinds-per-argument.md` (S2, filed by this audit; the type-variable twin was fixed in Phase 2.4) |
| `where(N > usize(0))` | rejected: `where` takes only `T <: Trait` forms |
| the index language | none: a length is a literal, a bare binder, or a bare projection; there is no symbolic arithmetic and no normalization, and none is needed because every length is concrete by the time a body is evaluated (Zig model) |

### 2.2 Layer 2 — erased refinements over runtime values (the verifier, V1–V7 landed)

- `refine(T, p)` is a real type (`TypeValue.RefineT`, `src/types/definitions.yo:374`), **erased for typing** (`t_refine_inner`; `refine(T, p)` and `T` flow both ways) and **enforced only by the verifier**: the callee assumes `p(param)`, every call site proves `refine#N`. This is exactly ATS's subset-sort + erasure. Families: `NonZero`, `Bounded(T, lo, hi)`, `Positive`, `Even`, … (`std/spec/refine.yo`, `std/spec/numeric.yo`), each with a runtime gate `check_*` → `Option(Refined)` and a trusted `unchecked_*`.
- `requires` / `ensures` with the labeled return, `old`, loop `invariant`, `decreases` (recursion and loops), `assumed()`, `law(...)`, `ghost` / `ghost_fn`, `forall` / `exists` / `==>` (ghost-only), ghost `Seq` / `Set` / `Multiset`, `ms_of(array)`.
- Modular, Dafny-shaped: the caller proves the callee's `requires` and `refine#k`, then assumes its `ensures` (`_callee_call_term`, `src/verifier/vc.yo`); no summaries, no inlining except `ghost_fn`, no precondition inference.
- Encoding: fixed-width bitvectors (target-sized `usize`), value enums as datatypes, `Array(T, N)` as an SMT array, quantifiers via MBQI; one Z3 5.1.0 process per query, sha256 verdict cache, rlimit + seed for determinism.
- **Where it runs:** `yo verify` (all files under the path); `yo check` / `yo compile` verify **only the entry file, only when it carries `Pragma.Verify` / `VerifyOrAssert`**; `yo test` compiles with `--no-verify`. A refuted obligation is a compile error; in `verify+` an unproven one degrades to the runtime assert. A file without the pragma never touches the solver.

### 2.3 The measured gap

```rust
pragma(Pragma.Verify);
{ ArrayList } :: import("std/collections/array_list");
get :: (fn(xs : ArrayList(i32), i : usize, requires(i < xs.len())) -> i32)(xs(i));
```

`yo verify` (2026-09-30): `subset fn@…:2 [verify] — cannot verify: parameter
outside the integer/bool/array subset`. The same contract over
`Array(i32, 4)` proves (2 obligations). So the verifier can state ATS's
`{n,i | i < n} (arr(a, n), int(i)) -> a` but cannot *discharge* it for any
collection whose length is a runtime value — which is every collection ATS's
examples are about. Structs, tuples, `ref` enums, slices, `ArrayList`,
generic-length arrays and `for` loops are outside the subset (`_fail_subset`
sites in `vc.yo`); contracted **generic bodies are not walked at all**
(`issues/verifier-contracted-generic-fn-is-silently-unverified.md`).

### 2.4 Existential types — what Yo has

Asked directly ("does Yo already support existential types?"): **yes, in the
two forms a monomorphizing C backend can pay for, and no in the third.**

| Form | Yo | Notes |
| --- | --- | --- |
| **Packed, erased existential** (`∃T. T × vtable(T)`) | `Dyn(Trait)` — a fat pointer `{data, vtable}`, `dyn(v)` packs, `downcast(d, T)` / `upcast(d, Dyn(...))` (`docs/en-US/DYN_DESIGN.md`) | The trait-object existential. Object-safety rules bound what can be hidden (`self` first, no `Self` elsewhere, no `generic` params). `Dyn(Fn(...))` is the erased closure. |
| **Opaque existential with static identity** (Rust `impl Trait`) | `Impl(Trait)` in argument and result position; `Impl(Fn(...))` closures; `Impl(Future(T, E))` for async | Not erased: the hidden type is the def-time body's type (`src/evaluator/calls/function_type.yo:1922-1957`), every return path must agree, and codegen monomorphizes. `plans/archive/FORALL_TO_GENERIC.md` already calls `Impl(Future(T, E))` "an existential type". The hidden type is *not* abstract to callers under the identity relation ("a resolved SomeT stands for its resolution", `plans/reference/TYPE_IDENTITY.md`) — an abstraction leak, not a soundness one. |
| **Existential enum constructors** (`Wrap(generic(T), value : T, show : fn(T) -> String)`) | **not supported** — E0401 `Variable "T" not found` (measured); documented non-goal in `docs/en-US/GADTS.md:147`, `plans/reference/GADTS.md` §"No existential types", `plans/backlog/IN_DESIGN.md` ("Low priority": `Dyn` covers it; skolemization is the cost) | The classic ML existential. Its lowering in a monomorphizing compiler is exactly a `Dyn`: a hidden `T` with no vtable cannot be operated on, and with one it is `Dyn`. |
| **Index existentials** `[n:nat] list(a, n)` | already the default: a runtime `ArrayList(T)` *is* "a list of some length `n`"; `ensures(r.len() == …)` names the witness | Nothing to add: in the refinement reading the witness is the measure `len`, a ghost value. |

Recommendation: keep the non-goal for constructor existentials (it buys
nothing `Dyn` does not, and skolemization is a new checker mechanism during a
soundness campaign), and document the three forms that exist under one
heading in `docs/en-US/DESIGN.md` + `docs/zh-CN/DESIGN.md` (E1 in §5).

## 3. The correspondence, line by line

| ATS / DML | Yo today | Verdict |
| --- | --- | --- |
| `{n:nat}` universal index on a fn | `generic(N : usize)` — but monomorphized per `N`, and `N` must be comptime-known at each call | Different semantics (§1). The erased-symbolic reading is `requires` / `ensures` over `.len()`. |
| `[n:nat]` existential index | plain runtime value + `ensures` naming the witness | Present (ghost witness). |
| `int(n)` singleton | none | Not needed: the value *is* the index once indices are ghost. Spelled `ensures(r == xs.len())`. |
| `sortdef nat = {a:int \| a >= 0}` | `refine(T, p)`, `NonNegative(T)` | Equivalent, erased, Z3-checked. |
| `list(a, m+n)` in a result | `ensures(r.len() == (a.len() + b.len()))` | Equivalent statement; **not dischargeable today** for `ArrayList` (§2.3). |
| `{i:nat \| i < n}` dependent refinement of a parameter on another | `requires(i < xs.len())` | Equivalent. A `refine` predicate is a closed one-parameter ghost, so the type-position spelling `i : refine(usize, i < xs.len())` is not expressible — and adds nothing under erasure. |
| constraint solving during `patsopt -tc` | `yo verify`; `check`/`compile` only for pragma'd entry files | Policy difference (§6). |
| linear-arithmetic builtin solver, Z3 for the rest | Z3 only, bitvectors (non-linear decided by bit-blasting) | Yo's is the stronger theory, at a cost model ATS avoids for the common case. |
| `prfun` / `dataprop` / `praxi` | `ghost_fn` (inlined, non-recursive), `law(...)`, `assumed()`; no user uninterpreted functions, no inductive props | Partial. Lemmas-by-recursion (`prfun` over `dataprop`) have no counterpart; `law` is the axiom/lemma entry point. |
| proofs erased | `ghost`, `refine`, contracts in `verify` mode erased | Equivalent. |
| views, linear types | RC ownership analysis, `own` / `inout`, `Iso`, `Send` (`plans/reference/MEMORY_SAFETY.md`, `PARALLELISM_RULES.md`) | Orthogonal; Yo's answer is different and already decided. |
| `t@ype` vs `type` templates | value types monomorphized; `ref(...)` / `Dyn` share one C representation | Same split, same reasons. |

## 4. What is rejected, and why

Adding the ATS surface — index sorts, `{n}` / `[n]` binders on signatures,
singleton `int(n)`, `where(N > 0)` over a symbolic `N`, and constraint
generation inside unification — is rejected. The reasons are Yo-specific,
not "dependent types are hard":

1. **It is a second kind of generic with the opposite specialization rule.**
   `generic(N : usize)` means "re-evaluate the body at this `N`, emit one C
   function per `N`". An ATS `{n}` means "one body, one C function, `n` never
   exists". Both binders would have to coexist on `Array(T, N)`, and the
   evaluator would need to know, per binder, whether a length is a value to
   fold or a symbol to constrain. That split runs through `evaluate_array_type`,
   the substitution's value half (`len_var_names`), `_compat_impl`'s
   length rule, the synthesizer's `Array` case, `type_key` and the
   specialization caches — every site the soundness campaign is currently
   straightening (Phase 3 type identity, `TYPE_IDENTITY.md`).
2. **It needs a new type-variable kind.** Index variables are not `SomeT`s
   (they range over values and carry constraints, not resolutions). The
   soundness campaign's standing constraint, restated by its owner on
   2026-09-30: no new type-variable kind until a type-variable identity
   design exists (the memory plan needs the same design;
   `TYPE_SYSTEM_SOUNDNESS.md` §3). Filing this plan does not change that
   order.
3. **Type equality would call the solver.** Matching `Array(u8, N + 1)`
   against `Array(u8, 3)` is an equation to solve, not a value to compare;
   the position document's reason 1 stands, and the "decidable fragment"
   escape only holds if the index language is kept closed (linear
   arithmetic). Yo's verifier already uses bitvectors, so index constraints
   would inherit a non-linear, bit-blasted theory in the checker's hot path.
4. **It changes the verifier's place in the pipeline** (§6) — from a
   separate pass over the evaluated AST to a client of unification — which
   reverses the 2026-09-04 architecture decision in `FORMAL_VERIFICATION.md`
   ("a separate verifier pass … not an evaluator extension").
5. **It buys no expressiveness.** With erasure, `Vec(T, n)` is
   `{v : Vec(T) | len(v) = n}` (the liquid-types reading of DML), and Yo
   already has the right-hand side. Everything ATS proves about indices, Yo
   can state today; what it cannot yet *discharge* is a verifier subset
   issue (§2.3), which is cheaper to fix than a checker extension and
   fixes the same programs.

The position document's four reasons therefore survive the audit with one
clarification: they reject *runtime-valued types with a definitional-equality
checker*, and ATS never had those either. Its model lands in Yo as Layer 1 +
Layer 2, not as a Layer 3.

## 5. The plan (what we DO do)

Phases are independent unless a dependency is named. Effort is for one
contributor with a tree-built compiler. Every phase ships behind the usual
seed gate for `std/` and `src/` adoption.

### R1 — a `len` measure for runtime collections (the substance)

> **Slice 1 (branch `feat/verifier-list-len`, 2026-09-30):** `ArrayList(T)`
> with an integer/bool `T` is the verifier datatype `List_<elem>` — a
> (contents : Array BV64 elem, len : BV64) pair; `xs.len()`, `xs.is_empty()`
> and `xs(i)` reads (under `index-in-bounds`) are modeled; list-typed
> parameters and callee results are one datatype-sorted term, so the
> length contracts below discharge modularly (`tests/spec/fixtures/valid/dml_list_get.yo`,
> `negative/dml_list_get_false.yo`, `tests/internal/verifier_list_len.test.yo`).
> **Slice 2 (branch `feat/verifier-list-mutation`, stacked, 2026-09-30):**
> the mutation model. std already carried `assumed()` contracts on
> `push`/`insert`/`remove`/`swap`/`set_len` (V6 task 5); `new` and
> `with_capacity` gained `ensures(r.len() == usize(0))`. At a call site a
> method call's receiver is its `self` argument; a list-typed named
> argument whose callee contract mentions `old(<param>)` is rebound to a
> fresh term and the ensures is assumed with `old(...)` reading the
> pre-call term (`ctx.call_pre`); a loop body's havoc set includes such
> receivers. `concat`'s body proves (`valid/dml_list_concat.yo`). The
> "old mentions modifies" convention is filed as
> `issues/questions/modifies-clause-for-callee-side-effects.md`.
> **Slice 3 (branch `feat/verifier-list-get-pop`):** `get` (total: `Some`/`None`
> by bounds, no obligation) and `pop` (`Some(last)` + receiver rebound to
> len − 1 when non-empty) as the call's own `Option(T)` datatype
> (`valid/dml_list_get_pop.yo`). A pop counts as a mutation for the
> `old(<param>)` rule. The slice also closed a false proof in slice 2: the
> model gives each NAME its own list value, but `ArrayList` is a reference
> type, so a mutation beside a possible alias (a local bound from an
> existing list, or a second parameter of the same list type) is now a
> subset error (`issues/fixed/verifier-list-model-ignores-aliasing.md`). An
> alias-aware heap model (a frame condition such as "a and b are distinct")
> belongs with R2. Two encoder bugs surfaced on the way: a zero-field
> constructor encoded as `(Name)`
> (`issues/fixed/verifier-a-zero-field-variant-encodes-as-an-invalid-application.md`)
> and a projection's bit width read as 1. Left: task 4 (generic bodies),
> `for` over a list.

**Goal:** the DML worked examples verify end-to-end over `ArrayList(T)`,
`Array(T, N)` with generic `N`, and `RawSlice(T)`:

```rust
pragma(Pragma.Verify);
concat :: (fn(a : ArrayList(i32), b : ArrayList(i32), ensures(r.len() == (a.len() + b.len()))) -> (r : ArrayList(i32)))(...);
get    :: (fn(xs : ArrayList(i32), i : usize, requires(i < xs.len())) -> i32)(xs(i));
zip    :: (fn(a : ArrayList(i32), b : ArrayList(i32), requires(a.len() == b.len()), ensures(r.len() == a.len())) -> (r : ArrayList(i32)))(...);
filter :: (fn(xs : ArrayList(i32), ensures(r.len() <= xs.len())) -> (r : ArrayList(i32)))(...);
reverse:: (fn(xs : ArrayList(i32), ensures(r.len() == xs.len())) -> (r : ArrayList(i32)))(...);
```

Tasks:

1. **Model `ArrayList(T)` in `vc.yo` as a ghost pair (contents : ArrS, len :
   BV64)** for `T` in the integer/bool subset, the way `Array(T, N)` is an
   `ArrS` today; a parameter of that type declares both. `len` is the
   measure; `xs(i)` is `select` under the `index-in-bounds` obligation
   `i < len`. Slices identical. (Struct modeling in general stays out:
   this is one nominal type with a known shape, not the heap model of open
   question 1.)
2. **Contracts on the std ops as `assumed()` signatures** —
   `len`, `get`, `set`, `push` (`len' == old(len) + 1`, element `i < old(len)`
   preserved), `pop`, `insert`, `remove`, `clear`, `new`, `with_capacity`
   — in `std/collections/array_list.yo`. This is `FORMAL_VERIFICATION.md`
   V6 task 5 slice 2, already written, blocked on a seed carrying the
   `assumed()` clause (the seed compiles `std/`); v0.2.46 carries it, so
   the gate is open. Each contract is an axiom the caller assumes: keep them
   minimal and *measured* (a wrong `ensures` here is unsound for every
   caller).
3. **`inout` collections through the two-state rule** (`old(xs.len())`):
   `push` on an `inout` receiver is a havoc of `xs` followed by the
   assumed `ensures`. The V4 two-state machinery (`inout_two_state.yo`)
   already does this for integers.
4. **Generic `N` in the subset.** A parameter `Array(T, N)` with `generic(N :
   usize)` is verified per monomorphized call today (bodies of contracted
   generic fns are not walked — `issues/verifier-contracted-generic-fn-is-silently-unverified.md`).
   R1 does not fix that issue; it records that a generic-length body
   verifies at each concrete `N` only, and leaves the abstract walk to that
   issue.
5. **Fixtures:** `tests/spec/fixtures/valid/dml_{concat,get,zip,filter,reverse}.yo`
   plus a negative twin each (`dml_concat_false.yo`: `ensures(r.len() ==
   a.len())`), driven from `tests/internal/verifier_dml.test.yo`
   (solver-free subset assertions; refutations behind `YO_TEST_Z3=1`), and
   the CI verify job runs them. **Exit criterion:** all five prove, all five
   twins refute with a counter-example naming the lengths.

Estimate: 3–4 weeks. Risk: the `ArrayList` C representation changing under
the ghost model is irrelevant (the model is spec-only), but `assumed()`
contracts that disagree with the std implementation are a silent
unsoundness — each contract gets a runtime-mode fixture that executes it
(`refine_nonzero_runtime.yo`'s pattern) so the assert form is also tested.

### R2 — the ATS lemma layer: recursive `ghost_fn` and user uninterpreted measures

**Goal:** what ATS does with `prfun` over `dataprop` (sortedness, permutation,
"element `k` occurs in `xs`") for runtime collections. Today `ghost_fn` is
inlined and a recursive one is a subset error; users cannot declare an
uninterpreted function; `Seq`/`Multiset` exist only as ghost values over
literals and fixed arrays (`ms_of`).

1. `ghost_fn` with `decreases`: encode as a recursive SMT function
   (`define-fun-rec`) with the measure as its termination witness, or as an
   uninterpreted symbol plus the body as a quantified definition axiom with
   a `:pattern` trigger — the `ms_of` precedent (`vc.yo:3284-3347`) already
   emits the second shape. Decide by measurement on
   `spec_insertion_sort.yo` (the existing capstone) re-spelled over an
   `ArrayList`.
2. `seq_of(xs)` for an `ArrayList` (the R1 contents array as a ghost `Seq`),
   so `ensures(seq_of(r) == seq_append(seq_of(a), seq_of(b)))` — ATS's
   `append` `dataprop` — is one line.
3. Fixtures: `dml_append_seq.yo`, `dml_sorted_insert.yo`, `dml_member.yo`,
   each with a negative twin.

Depends on R1. Estimate: 3 weeks. This is the phase to cut if the budget is
one phase: R1 alone covers length indexing, which is 90 % of what ATS
programs index by.

### I1 — computed comptime lengths in non-binding positions (Layer 1)

**Goal:** `-> Array(u8, N + usize(1))` and `(r : Array(u8, N * usize(2)))`
compile; `Array(u8, N + M)` in a result with both `N` and `M` bound by
parameters compiles. **Binding positions stay bare** (a parameter type
`Array(u8, N + usize(1))` is still rejected, with the existing message):
a length is inferred only from a bare binder or a bare projection, which is
the DML "index pattern" restriction and Rust's stable const-generics rule,
and it is what keeps unification free of arithmetic (§4 reason 3).

1. `evaluate_array_type` records a computed length expression whose free
   names are all generic binders of the enclosing signature as a
   *deferred* length (the way a bare projection is recorded today), instead
   of erroring — but only in result and body positions; parameter positions
   keep the error (they are matching positions).
2. Substitution (`_subst_resolve_len_projection`'s sibling) evaluates the
   recorded expression by CTFE once every binder is bound; a length that
   does not fold to a `usize` is the existing hard error (never 0 —
   `VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md` step 1).
3. Type keys and the CTFE memo see only the folded value (the deferred
   expression must never leak into `type_key`; gate: emitted-C
   byte-identity on the current corpus, per the soundness campaign's rule
   for anything that touches type keys).
4. Tests in `tests/array.test.yo`: the three shapes above, the
   parameter-position rejection, `N + M` with the two binders bound by two
   arguments.

Depends on: `issues/fixed/a-usize-generic-binder-rebinds-per-argument.md` being
fixed first (the "second concrete binding disagrees" check for value
binders — a computed result length built on a rebinding binder would
silently size a buffer by the wrong argument), and on the soundness
campaign's in-flight symbolic-length work (`tss/impl-self-operator`
binds a var-var `Array` length; I1 must build on that shape, not beside
it). Estimate: 1–2 weeks after those land.

### E1 — document the existentials Yo has (docs only)

One section "Existential types" in `docs/en-US/DESIGN.md` and
`docs/zh-CN/DESIGN.md` (both, per the doc rules): the three forms of §2.4,
which one to reach for (`Dyn` to store heterogeneous values, `Impl` to
return one hidden type without a vtable, contracts for hidden lengths), and
the non-goal for constructor existentials with its reason. Cross-link from
`GADTS.md`'s "No existential types" line. Half a day.

### Q1 — a policy question (DECIDED 2026-09-30: a build step, never a `check` switch — `__yo_build_verify` landed, `build.verify` wrapper seed-gated)

`issues/fixed/verify-by-default-for-a-project.md`: should a `yo.toml`
or `build.yo` switch arm every file of a project as a verify target (the
ATS "type checking proves indices" experience), rather than the per-entry
pragma? Today only the entry file is verified under `check` / `compile`,
imported modules never are, and `yo test` compiles with `--no-verify`.
Recommendation to state in the question: **no** for `check` (Z3 is a
downloaded binary and `check` must stay solver-free — since #760 a missing
Z3 is a skip-with-hint), **yes** as a `build.yo` step (`yo verify` over the
project's roots, already available; wire it as a build step like `test`).

### Order and cost

| Phase | Depends on | Weeks | Delivers |
| --- | --- | --- | --- |
| R1 | v0.2.46 seed (open) | 3–4 | length-indexed collections, ATS's headline |
| R2 | R1 | 3 | ATS's `dataprop` / `prfun` layer over collections |
| I1 | usize-binder fix; `tss/impl-self-operator` | 1–2 | computed comptime lengths in result/body positions |
| E1 | — | 0.5 | the existential story written down |
| Q1 | — | 0 | decided; the verify build step landed (Generation A) |

## 6. How this interacts with the Z3-backed verifier

Asked directly: would supporting dependent types change how the current
formal-verification system works?

**Under this plan (R1/R2/I1): no architectural change.** The verifier stays a
separate pass over the evaluated AST, modular per function, opt-in per file,
with `verify+`'s runtime fallback, one process per query, the sha256 cache
and the deterministic budget. R1 and R2 *extend its subset* (a new modeled
type, two new ghost operators, a recursive `ghost_fn` encoding) through the
same entry points the existing ghost collections use — `_type_sort`,
`_callee_call_term`, the `ms_of` axiom shape. I1 never reaches the
verifier: a folded comptime length is a literal by the time `vc.yo` sees it.
The one visible policy change is the std contracts (R1.2): once
`array_list.yo` carries `assumed()` signatures, *every* verify-mode caller of
`push`/`get` starts discharging `requires` obligations it did not have
before — which is the point, and which is why those contracts are measured
against the implementation before they land.

**Under the rejected alternative (ATS notation in the checker): yes, in four
ways, each of which is a reason it is rejected.**

1. **The solver would move into `yo check`.** Every unification of two
   indexed types is a constraint; a failed one is a type error; so the
   checker needs Z3 for any file that mentions an index. Today `check` ships
   nothing and a missing solver is a hint (#760). A `check ./src` round
   (~105 s cold) would add one query per indexed call site — at one Z3
   process per query (V2's chosen isolation) that is seconds to minutes on
   the compiler tree, and the `--watch` incremental loop would have to
   invalidate solver verdicts by edit.
2. **No runtime fallback.** `verify+`'s "degrade an unproven obligation to
   an assert" is meaningless for an index equation whose indices are
   erased: either the checker proves `n + 1 = m` or the program has no type.
   Every `unproven` becomes a hard error, which is exactly the Dafny UX the
   flagship-mode decision (`FORMAL_VERIFICATION.md` §"Goal") chose to avoid.
3. **Two obligation generators for one theory.** Unification-time index
   constraints and the verifier's contract VCs would both encode bitvector
   arithmetic through `terms.yo`/`encode.yo`, from two walks with two
   notions of path condition (the checker has none). Keeping them
   consistent — the same `n` in a `{n}` binder and in a `requires` — is a
   new invariant with no owner.
4. **The architecture decision flips.** `FORMAL_VERIFICATION.md` (2026-09-04)
   chose "a separate verifier pass … not an evaluator extension" after the
   2026-05 draft's evaluator-extension estimate (4–6 months for path
   conditions alone). Constraint generation during elaboration is the
   evaluator extension, under a different name.

ATS2 itself is the evidence for the plan's direction: its own solver could
not keep up, so it exported constraints to Z3 out of band
(`--constraint-export` → `patsolve_z3`) — a separate verification pass over
type-checker output, which is the architecture Yo already has.

## 7. What was measured for this audit

All on macOS arm64, develop `df3798c4a`, `yo 0.2.46` (installed seed), 2026-09-30:

| Program | `check` | Note |
| --- | --- | --- |
| `Array(u8, usize(2) + usize(3))` against `Array(u8, 5)` | ok | literal arithmetic folds |
| `generic(N : usize)` binder, two same-length arrays, `-> Array(u8, N)` | ok | |
| `generic(N : usize)` binder, lengths 2 and 3 | **ok (wrong)** | compiles, runs, prints the last argument's `N` — the filed issue |
| `-> Array(u8, N + usize(1))` | rejected | "not a compile-time constant, a bare generic parameter, or an associated constant" |
| `enum(Pack(T : Type, value : T, …))`, `enum(Pack(comptime(T) : Type, …))` | rejected | E0401 — no constructor existentials |
| `-> Impl(Fn() -> i32)` returning a capturing closure | ok | the opaque existential |
| `where(N > usize(0))` | rejected | `where` is trait bounds only |
| `requires(i < xs.len())` on an `ArrayList` param, runtime mode | ok | the assert form works |
| same under `pragma(Pragma.Verify)`, `yo verify` | **subset error** | "parameter outside the integer/bool/array subset" |
| `requires(i < usize(4))` over `Array(i32, 4)`, `yo verify` | ok | 2 obligations proved |

## 8. Sources

- Xi, Pfenning — *Dependent Types in Practical Programming* (POPL 1999); the DML index-language design ATS inherits.
- ATS2 / Postiats: `patsopt -tc --constraint-export` + `patsolve_z3` / `patsolve_smt2` — the ats-lang-users thread "ATS + Z3" (Xi: the builtin solver handles what "cannot be handled by patsopt but can be by patsolve_z3", e.g. `stacst` functions), and "Writing basic proofs in ATS" (bluishcoder.co.nz, 2018): `{n:nat}` / `[n:nat]`, `dataprop`, `praxi`, "proofs are erased after typechecking".
- Rondon, Kawaguchi, Jhala — *Liquid Types* (PLDI 2008): refinement types as the erased reading of DML indices.
- In-tree: `DEPENDENT_TYPES_POSITION.md`, `FORMAL_VERIFICATION.md` (V1–V7), `VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`, `plans/reference/TYPE_IDENTITY.md`, `plans/reference/GADTS.md`, `plans/backlog/IN_DESIGN.md` §"Existential types", `docs/en-US/DYN_DESIGN.md`, `std/spec/refine.yo`.
