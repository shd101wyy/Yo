# Type system soundness: make `yo check` a gate, not a filter

**Status:** ACTIVE, proposed 2026-09-23. **Handover (updated 2026-09-28):** [`TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`](TYPE_SYSTEM_SOUNDNESS_HANDOVER.md) says where each phase stands and what is on which branch. Phases 0, 1 and 2 LANDED 2026-09-24/25 (the per-phase
"Landed" notes below); 3–7 open. Source: a six-part audit of the type system on
develop `7e0187d59` with the v0.2.39 seed, re-verified on a develop-built compiler (see §7).
Every finding is filed under `issues/`. This doc is the roadmap for fixing them.

## 1. What kind of type system Yo has

Yo's checker is **local bidirectional type checking on top of a Zig-style comptime evaluator
that monomorphizes generics at each call**. It is not Hindley–Milner.

- **Bidirectional, informally.** `EvalContext.expected_type : Option(ExpectedTypeCtx)`
  (`src/evaluator/context.yo`) carries a top-down type into sub-expressions. Check mode is "the
  slot is `Some(T)`"; synthesis mode is "the slot is `None`". The slot is set at function-body
  entry (the declared result), typed bindings, call arguments (Step 3 of
  `check_if_function_parameter_matches_argument`), `cond`/`match` arms, and array/tuple
  elements. It drives integer-literal typing, `.Variant`/`.None` shorthand, and closure
  parameter types. A `=>` literal with no expected type is a hard error ("Expected a function
  type"), which is the classic bidirectional rule "lambdas are checked, not synthesized".
- **Not a separate judgment per mode.** There is no `check(e, T)` / `synth(e)` pair. Every node
  evaluator reads one shared mutable slot and saves/restores it around sub-evaluations. Where a
  consumer forgets to use it (a closure's result, a generic body's result) nothing is checked;
  that is the root of several holes below.
- **A unifier exists but is not HM.** `synthesize_types` (`src/evaluator/types/synthesizer.yo`)
  is first-order, asymmetric (expected vs given) and has an occurs check. Type variables are
  `SomeT` values bound in an `Environment`, substituted by `(name, frame_level)` keys
  (`src/types/substitution.yo`). There is no let-generalization, no principal types, and no
  global constraint solving: unification runs as a binding step inside one call's specialization,
  so results can depend on evaluation order.
- **Polymorphism is compile-time evaluation.** `comptime(T) : Type` and `generic(T : Type)` bind
  `T` as a comptime value; a call re-evaluates the body at concrete types and caches the
  specialization by `type_key` (`g_specialized_fn_caches`, `src/evaluator/calls/helper.yo`). Type
  constructors are ordinary comptime functions memoized by the CTFE memo. That is Zig's model,
  with trait bounds (`where`, `Impl(Trait)`) layered on top.
- **Type identity is id-based and position-keyed**, not structural: structs and enums compare
  by a stamped name/id derived from source row/column, and codegen has its own finer identity
  (`_type_key_at`). The two disagree in places.

### Should Yo move toward HM?

No. Yo has no overloading, types are first-class comptime values, and every generic is
monomorphized, so let-polymorphism would buy little and fight the comptime model. What Yo needs
is the discipline HM-family and bidirectional systems share:

1. **Explicit modes.** Every node either checks against a type or synthesizes one, and every
   check site compares the synthesized type with the expected one. No node may silently adopt
   the expected type as its own.
2. **Per-call unification.** One fresh set of type variables per call, shared by every mention
   of a binder in the signature, with "second concrete binding disagrees" as an error. Solve
   arguments that synthesize first, then check lambda arguments against the solved types (the
   Pierce–Turner / Scala / Rust "local type inference" ordering).
3. **One identity predicate.** Type equality means one thing everywhere: the memo, exact
   compatibility, interning and codegen.

## 2. The headline

`yo check` is documented internally as "a filter, not a gate". The audit makes that concrete:
**the C compiler, an internal compiler error, or a runtime `FATAL` is today the type checker of
last resort for at least 40 open issues**. The eight worst reproduce as wrong behaviour in a
program that passes both `check` and `compile`:

| Program | What happens | Issue |
| --- | --- | --- |
| `(y : Value(bool)) = Value(i32).IntVal(77)` then `eval_value(y)` | prints `77` from a `bool` | `issues/enum-type-constructor-arguments-are-ignored-by-type-compatibility.md` |
| move an `ArrayList` into an `own` param inside a `while` | use-after-free, prints garbage | `issues/fixed/moving-a-variable-inside-a-loop-body-is-not-rejected.md` |
| call an `inout` fn through a fn value | the pointer is truncated to `int32_t`; the seed's binary loses the mutation | `issues/fixed/inout-call-through-a-fn-value-loses-the-mutation.md` |
| push to a module-global `ArrayList` from two threads | data race, contract failure | `issues/fixed/module-globals-bypass-send-so-safe-code-can-data-race.md` |
| `Iso` a wrapper whose interior is aliased | data race | `issues/iso-checks-only-the-wrapper-refcount-not-the-interior.md` |
| `apply(x => true, 3)` where `Fn(x : i32) -> i32` is expected | prints `1` | `issues/fixed/closure-result-type-is-not-checked-against-the-expected-fn-type.md` |
| `pair_same(String, i32)` with `fn(generic(A), x : A, y : A)` | runs | `issues/fixed/generic-type-var-rebinds-per-argument.md` |
| `Wrap(fn(x : i32))` then `Wrap(fn(inout(x) : i32))` | SIGSEGV | `issues/fixed/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md` |

## 3. Root causes (themes)

The ~60 findings (22 new issue docs, 7 extended, the rest already open) reduce to eight causes.
Each phase in §5 attacks one or two of them.

| # | Root cause | Representative issues |
| --- | --- | --- |
| R1 | **A check site forgets to compare.** The expected type is adopted instead of checked, or a check exists on one path and not its twin. | closure result; generic body result (`check_deferred_generic_return_type` is a no-op stub); `impl` never checked against the trait; `Impl(Trait)` return bound; context-typed literals not range-checked; enum payload at construction; `==`/`<` without a trait types as `unit` |
| R2 | **Def-time trial evaluation swallows errors.** A body that fails to type-check becomes an FTT `abort()` stub behind a green gate. `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` §8 explicitly left this policy alone. | closure body errors; handler `return`/`unwind` type errors; `mutual-recursion-between-a-fn-and-a-trait-impl-body`; `anonymous-module-trial-swallows-a-top-level-derive`; `derived-eq-ref-enum-self-payload-hollow-at-runtime` |
| R3 | **No per-call unification state.** Every mention of a type variable resolves through its own lineage; `resolved_concrete` is a shared mutable cell; last write wins. | `generic-type-var-rebinds-per-argument`; `generic-fn-type-compatibility-is-not-alpha-equivalent`; `order-dependent-generic-slot-stranding-e0605`; `iterator-chain-shared-stamp-cross-item-pollution`; HKT `TypeApp(F, [A])` never applied; uninferable binder ICEs; order-dependent `cond` arm join |
| R4 | **The compatibility relation is not an equivalence or a preorder.** Empty names are wildcards, same-name structs match, fn param modes and tuple labels are ignored, `Dyn` exact equality is a subset test, enum type arguments are ignored. | enum/GADT index laundering; name/wildcard struct compat; CTFE memo merging; `an-extern-opaque-type-unifies-with-every-dyn` |
| R5 | **Identity comes from source position and is computed twice.** Ids are `r<row>c<col>` without a module; the evaluator id and codegen `_type_key_at` disagree. | `trait-ids-omit-the-module-so-two-traits-can-share-one-id` (now also anonymous structs); `a-two-line-comment-change-in-std-prelude-fails-check-std`; `option-of-a-trait-object-never-emits-its-inherent-methods`; `a-box-over-an-impl-fn-is-emitted-as-two-c-structs`; `plans/backlog/TYPEVALUE_HASH_CONSING.md` is blocked on this |
| R6 | **No trait coherence.** Duplicate, cross-module, prelude-overriding and blanket-vs-explicit impls are all accepted; the first registered wins. | `yo-self-missing-duplicate-impl-checks`; `an-overlapping-blanket-trait-impl-is-silently-dead`; `stddoc-coll-duplicate-fromiterator-impl-on-hashset` |
| R7 | **Rules that live only in codegen.** Dyn object safety, async state-machine restrictions, some `inout` rules; users get clang errors or "internal compiler error … please report it". | `dyn-object-safety-is-not-enforced-before-codegen`; `user-facing-async-restrictions-reported-as-internal-compiler-error`; `io-await-on-a-join-handle-is-reported-as-an-internal-compiler-error`; `address-of-a-parameter-in-a-generic-fn-emits-a-placeholder` |
| R8 | **Ownership/thread-safety rules with an unguarded edge.** Each rule is right on its main path and has one unguarded edge: loop back-edges, whole-variable `inout` aliasing, globals, `Iso` interiors, ctl values in ref fields. | the five Phase 5 issues; `borrowed-arg-invalidated-by-aliased-container-mutation`; `module-level-control-bound-binding-not-rejected`; `cond-arm-initialization-merge-check-never-fires` |

## 4. Principles for every phase

- **Red first, through the tree-built compiler.** Each issue gets a `comptime_expect_error`
  test (or a cli-case for multi-file or runtime shapes) that fails before the fix. Run it with a
  compiler built from the branch, never the seed.
- **A new rejection will find violations in `std/` and `src/`.** Fix them in the same PR; that
  is the point of the phase. Record each one found in the PR body.
- **Gate every phase on:** `yo check ./src`, `yo check ./std`, the fast language suite, the
  `tests/internal` files that import the touched evaluator modules, and the fixpoint battery. Any
  change to type keys or ids (Phase 3) additionally needs the emitted-C byte-identity/renaming
  check.
- **Seed gate.** A new rejection needs no seed bump: the fix and the `std/`/`src/` cleanups it
  forces land together. A new type form that `std/` or `src/` would *use* (such as `never` in
  Phase 3.6) is seed-gated: the compiler support ships in a release first, and `std/`/`src/`
  adopt it after `SEED_VERSION` carries it (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

## 5. Phases

### Phase 0: a soundness ratchet (measurement before fixing)

Goal: a number that goes down, so progress is not a matter of opinion.

1. **Negative corpus.** Add `tests/type_soundness.test.yo` containing one
   `comptime_expect_error` per Phase 1–3 issue repro that fits in one file, each marked with the
   issue path. A test is added in the PR that fixes its issue, so the file is always green; the
   repros still waiting for a fix are the census in step 2.
2. **Check-green/compile-red census.** A script that runs `yo check` and then
   `yo compile --skip-c-compiler` plus clang over every `issues/**/repros/*.yo`, every Phase 5
   runtime repro, and every `tests/**/*.yo` that has a `main`. It counts programs that are green
   under `check` but fail later. That count is the headline metric of this plan.
3. **Swallow census.** `YO_DEBUG_SWALLOW=1 yo check ./std ./src` counts `[anon-swallow]` and
   def-eval swallows that carry a real type error (not a SomeT-pending deferral). This is the
   metric for Phase 6.

Exit: both counts recorded in this doc; the corpus runs in CI.

**Landed 2026-09-24.** `tests/type_soundness.test.yo` (in the fast suite, so in CI),
`scripts/soundness/census.sh` and `scripts/soundness/swallow-census.sh`.

Census log (408 programs: issue repros, the cited docs' inline repros, `tests/**` programs; the
headline is ICE + COMPILE_RED + CC_RED + FTT + RUN_FTT):

| Compiler | OK | CHECK_RED | ICE | CC_RED | RUN_FTT | RUN_SIGNAL | RUN_TIMEOUT | Headline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| develop before this PR | 287 | 88 | 9 | 11 | 4 | 8 | 1 | **24** |
| Phases 0–2.3 (PR #876) | 281 | 102 | 5 | 8 | 3 | 8 | 1 | **16** |

Transitions: 7 fixed repros OK → CHECK_RED (they compiled and printed the wrong value),
3 CC_RED → CHECK_RED, 4 ICE → CHECK_RED, 1 RUN_FTT → CHECK_RED (the mutual-recursion repro, now a
wrong check-time error, see `issues/fixed/mutual-recursion-between-a-fn-and-a-trait-impl-body.md`),
and the 1.5 canary CHECK_RED → OK. No OK program regressed except fixed-issue repros.

Swallow census (`YO_DEBUG_SWALLOW=1 yo check`, all channels):

| Compiler | `./std` | `./src` |
| --- | --- | --- |
| develop before this PR | 98 (22 distinct) | 63 (16 distinct) |
| Phases 0–2.3 (PR #876) | 102 (23 distinct) | 63 (16 distinct) |

The four new `./std` swallows are the new checks firing INSIDE a definition-time trial whose
receiver is still abstract — e.g. `std/imm/set.yo:64`, `self._inner.contains_key(elem)` on
`Map(T, bool)` types `unit` in the trial and now also reports E0604 against `-> bool`. They are
SomeT-pending deferrals, exactly what Phase 6 step 1 classifies; none is a real std error (each
specialization of those bodies type-checks).

### Phase 1: missing comparisons (R1), the cheap high-value fixes

Each item is one check at one site, with a test. No architecture change.

| Step | Fix | Issue |
| --- | --- | --- |
| 1.1 | Compare type-constructor arguments in the `EnumT` arm of compatibility; check a GADT variant's `-> recur(...)` index at construction; type-check each GADT arm once at definition with the index refined | `enum-type-constructor-arguments-are-ignored-by-type-compatibility` |
| 1.2 | E0604 for a closure body against the adopted `Fn(...) -> R` result | `closure-result-type-is-not-checked-against-the-expected-fn-type` |
| 1.3 | E0604 at the specialization cache miss; delete the `check_deferred_generic_return_type` stub | `generic-fn-body-is-not-checked-against-its-declared-result-type` |
| 1.4 | Range-check a literal against its context type; prefix `-` keeps `comptime_int` | `context-typed-integer-literal-is-not-range-checked` |
| 1.5 | Symmetric arm join for comptime and concrete numerics | `cond-arm-type-unification-depends-on-arm-order` |
| 1.6 | An operator whose trait lookup misses is an error, never `unit` (`==`, `<`, and the rest) | `equality-operator-without-an-eq-impl-evaluates-to-unit` |
| 1.7 | Check enum payloads at construction | `enum-variant-payload-type-is-not-checked-at-construction` |
| 1.8 | A closure is not a bare `fn(...)` pointer; a runtime arg is not a `comptime(v)` arg | `bare-fn-type-param-accepts-a-closure-then-emits-invalid-c`, `a-comptime-parameter-given-a-non-comptime-argument-emits-broken-c` |
| 1.9 | Codegen lowers `param_is_ref` parameters to `T*` in every fn-pointer type string (a codegen one-liner in effect, but it is wrong code today) | `inout-call-through-a-fn-value-loses-the-mutation` |

Already landed or in flight from a parallel session: comptime literal arguments are checked
against concrete parameters (#856, which closed
`issues/fixed/comptime-str-passed-where-string-is-declared-emits-invalid-c.md`), and `unwind` type mismatches in handlers are re-raised (branch `yo-context-c7`).

Exit: each step's test flips in the Phase 0 ratchet; the census count drops by at least the
number of steps.

**Landed 2026-09-24**, all nine steps; each issue is in `issues/fixed/` with its Fix and
Verification sections. Two stay open for their other halves: the generic-callee half of
`closure-result-type-is-not-checked-against-the-expected-fn-type` needs step 2.4, and the
evaluator half of `inout-call-through-a-fn-value-loses-the-mutation` is step 3.5. Found on the way
and fixed: `issues/fixed/comptime-integer-folding-clamps-instead-of-wrapping.md`. Split out and
open (Phase 6): `issues/fixed/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`.

### Phase 2: traits and generics (R3, R6)

1. **`impl` conformance.** After an `impl(T, Trait(...))` collects its members, check the
   trait's members: a missing member with no default, an unknown label, and a member type that is
   not compatible after `Self` substitution are all coded errors at the impl.
   (`impl-is-not-checked-against-the-trait-members`)
2. **Return and parameter bounds.** `-> Impl(Trait)` checks the body type against each required
   trait (E0602). A mismatch at an `Impl(Trait)` parameter reports E0602, not E0610.
   (`impl-trait-return-bound-is-not-checked`)
3. **Coherence, as a decision first.** Write `plans/reference/TRAIT_COHERENCE.md` choosing the
   rule. The recommendation:
   - reject two impls of one trait for one type;
   - reject a local impl of a trait for a type when an impl is already visible from an import,
     including the prelude;
   - reject a blanket impl that overlaps an existing concrete impl, unless a later specialization
     design says otherwise;
   - make trait identity module-qualified (Phase 3.3) so "same trait" is well defined.

   Then implement it in `register_type_trait_method` and the generic-impl registry. Fix the std
   violations it finds, starting with `stddoc-coll-duplicate-fromiterator-impl-on-hashset`.
4. **Per-call unification (the architectural step).** Implement the "per-call SomeT minting"
   design recorded in `issues/fixed/warm-test-batches-doc-stability-genericimplentry.md`:
   - At a call, clone the signature's binders into fresh SomeTs with fresh cells, one per binder.
     Every mention of a binder in the signature resolves through that one clone.
   - A second concrete binding that disagrees with the first is an E0601 naming the binder:
     "A is String from argument 1 but i32 from argument 2".
   - Argument order: synthesize the non-lambda arguments first, then check lambda arguments
     against the partly solved signature. That also fixes
     `generic-fn-forall-unresolved-when-argument-is-a-method-call`.
   - Compare generic fn types up to alpha-equivalence of binders.
   - After binding, normalize each `TypeAppT` whose constructor is bound
     (`higher-kinded-return-type-is-never-applied-at-the-call-site`).
   - A binder that appears in the result and is still unresolved with no expected type is a coded
     "cannot infer T" error (`uninferable-generic-result-passes-check-and-ices-in-compile`).

   This step retires the shared `resolved_concrete` cell and the global last-write-wins
   `g_some_resolved_concrete` table, which fixes a cluster of D-class issues
   (`order-dependent-generic-slot-stranding-e0605`, `iterator-chain-shared-stamp-cross-item-pollution`,
   `varbound-combinator-receiver-impl-match`, `calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet`,
   `generic-fn-specialized-at-two-types-hands-the-closure-the-wrong-param-type`). Measure the
   memory effect with the census from `plans/EVALUATOR_MEMORY_REDUCTION.md`, since each call now
   mints SomeTs.

   **Landed 2026-09-24, part 1** (per-call consistency, argument order, inference):
   - a binder bound to two incompatible types by two arguments is E0601 on both call paths
     (`issues/fixed/generic-type-var-rebinds-per-argument.md`);
   - function-literal (`=>` / `->`) arguments are matched after the others, against the
     signature they solved — fixing the generic half of
     `issues/fixed/closure-result-type-is-not-checked-against-the-expected-fn-type.md`, two
     pre-existing closure-first failures, and
     `issues/fixed/generic-fn-specialized-at-two-types-hands-the-closure-the-wrong-param-type.md`
     (the closure's `T` no longer resolves by name to a caller's `T`);
   - the expected type binds a result-only binder, and one nothing binds is the new E0613
     (`issues/fixed/uninferable-generic-result-passes-check-and-ices-in-compile.md`);
   - the Step 10 "adopt the expected type" gate is deep
     (`issues/fixed/generic-fn-forall-unresolved-when-argument-is-a-method-call.md`);
   - `F(A)` infers a kind-annotated `F` from an instantiation and the result is applied
     (`issues/fixed/higher-kinded-return-type-is-never-applied-at-the-call-site.md`);
   - `issues/fixed/calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md` was
     already fixed on the v0.2.41 seed; a regression test pins it.

   **Landed 2026-09-25, part 2:**
   - `issues/fixed/iterator-chain-shared-stamp-cross-item-pollution.md`: two instantiations that
     share one struct id (`IterMap` over two different closures) no longer share their
     impl-provided associated types. The durable assoc registry is keyed by the exact instantiation
     (`assoc_type_registry_key`: id + `type_key`), and every reader goes through
     `get_assoc_type_entries`;
   - `issues/fixed/generic-fn-type-compatibility-is-not-alpha-equivalent.md`: two generic fn types
     are compared up to renaming of their binders (a pair stack in `types/compatibility.yo`), so
     `fn(generic(T), x : T) -> T` accepts `fn(generic(U), x : U) -> U` and still rejects
     `fn(generic(U, V), x : U) -> V`;
   - `issues/fixed/varbound-combinator-receiver-impl-match.md`: a user-defined `flat_map`-shaped
     combinator over a variable-bound receiver resolves its impl (regression test in
     `tests/iterator_combinators.test.yo`).

   The shared `resolved_concrete` cell itself is NOT retired: every observable issue it caused
   is fixed where it arose, so removing the cell moved to Phase 3.7 and is no longer a 2.4
   prerequisite. `order-dependent-generic-slot-stranding-e0605` is
   still open. It depends on the iteration order of registries keyed by timestamp-minted ids, and
   that order stops varying only with Phase 3.3's position-independent ids, so it is tracked there.

5. **Unify the three parameter-binding sites.** `_build_def_time_body_env`,
   `check_if_function_parameter_matches_argument` and `_evaluate_funcval_runtime_call` each
   implement a subset of the arg/param rule (self-documented in `src/evaluator/calls/function.yo`).
   Factor the rule into one helper that all three call, so a fix made at one site applies to all.

   **Landed 2026-09-25.** The rule is now shared helpers:
   - `strip_argument_label`;
   - `consume_argument_for_parameter` (4a: no use of a moved argument; 4b: `own` moves; 4c: the
     borrowed-projection dup);
   - `check_argument_for_parameter` (the comptime-argument gate, literal fit and range, `Impl(Fn)`
     callability, `Impl(Trait)` satisfaction, and the comptime lowering);
   - `bind_parameter` (`env.yo`).

   Both call paths call the argument helpers. The definition-time body env and the
   specialization re-binds call `bind_parameter`. Every binding takes its flags from the
   DECLARATION: compile-time-only iff declared `comptime(...)`, `inout` → a reassignable
   reference, `own` → an owning binding. The inline arm used to guess compile-time-only from
   whether the argument had a value. Two user-visible bugs were copies of the rule drifting apart:
   `issues/fixed/a-free-function-call-accepts-an-already-moved-argument.md` (a use-after-move;
   the inline arm had no 4a) and
   `issues/fixed/a-folded-comptime-integer-argument-to-a-method-is-lowered-to-i32.md` (`h.g(100 +
   50)` rejected for a `u8` parameter).

   What stays site-specific, and why: the definition-time env binds with no argument at all.
   The `try_to_call` path binds the declared type after synthesis, and the inline arm binds the
   argument's type. The explicit `generic(...)` application check exists only on the inline arm,
   which is the only path that accepts one. An `undefined` argument's substituted default is not
   a caller expression and skips the ownership rule. The specialization re-binds of a closure parameter, or of one
   whose argument folded to a constant, stay NON-owning even for `own(p)`. The caller keeps and
   releases that temporary, and binding with the declared flag was tried and measured as a
   double release (corrupt `downcast` payloads in `tests/error_ergonomics`). The parallelism
   plan's D3 record (an `inout` argument rooted in an atomic object, `d3_record_inout_place`) is
   one predicate call in each argument loop, decided once the callee is known, so it needs no
   helper of its own.
6. **Associated types in free-fn `where`.** Execute `plans/archive/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`
   on top of step 4, because both are about binding a variable from a bound.

   **Landed 2026-09-25**, all three of that plan's options:
   - a binder that only a where-clause fixes (`A` in `where(I <: Iterator(Item := A))`) gets a
     per-call slot before the where-clause is applied, so the bound binds it on the inline
     `FuncVal` path, as the method path's Step 6c already did. A deferred closure's expected type
     reads it too (`_fv_where_assoc_binding`);
   - a closure argument's evaluated body type fixes a binder that only an `Fn` bound's result
     mentions (`J` in `F <: (Fn(item : A) -> J)`);
   - blanket combinators work on such a parameter (`it.fold`, `it.map(f).collect(...)`,
     `s.collect(io)` on a `Stream`). `tests/async/combinators.test.yo`'s `_bounded` now takes the
     stream instead of its collect future;
   - E0602 names a mismatched associated type ("its associated type Item is String, not i32");
   - two bugs found on the way: `issues/fixed/fn-trait-pairs-are-never-synthesized.md` (the
     synthesizer's TraitT case swallowed Fn/Future pairs, and `Dyn` had no case) and
     `issues/fixed/self-referential-bound-rejects-every-candidate.md` (`A <: Add(A)`).
7. **Dyn object safety in the evaluator.** Reject, with a code, trait members whose signature
   mentions `Self` outside the receiver or takes `generic(...)` binders, when forming `Dyn(Trait)`
   or calling through it. Decide whether upcasting `Dyn(A, B)` to `Dyn(A)` is supported.
   (`dyn-object-safety-is-not-enforced-before-codegen`,
   `blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable`)

   **Landed 2026-09-25:**
   - one predicate (`dyn_member_unsafe_reason`, `src/types/utils.yo`) decides which trait methods
     get a vtable slot: `self` first, `Self` only as the receiver, no `generic(...)`. Calling any
     other method through a `Dyn` is the new E0614, at the call. Forming the `Dyn` stays legal
     (`issues/fixed/dyn-object-safety-is-not-enforced-before-codegen.md`);
   - codegen dispatches through the vtable only for a slot, so a blanket inherent method on a
     `Dyn` receiver is a direct call
     (`issues/fixed/blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable.md`);
   - `dyn(x)` over a trait `x` gets from a generic impl specializes that impl's methods for the
     vtable (`issues/fixed/dyn-cannot-resolve-a-trait-method-that-comes-from-a-generic-impl.md`);
   - an inherent impl on a `Dyn` type registers, so `std/error.yo`'s `error_is(err, T)` became
     `err.is(T)` (`issues/fixed/an-inherent-impl-on-a-dyn-type-registers-nothing.md`);
   - **upcasting is not supported**: `Dyn(A, B)` and `Dyn(A)` have different vtable layouts, and
     the concrete type is erased. The mismatch carries a note saying so. DYN_DESIGN.md en/zh
     records the rules;
   - found on the way: `comptime_expect_error`'s expected-text argument had never been checked
     (`issues/fixed/comptime-expect-error-never-checked-its-expected-text.md`). It is now, and 14
     cases in 6 files that had been matching a different error were corrected.

8. **Explicit Dyn upcast (added 2026-09-27).** Step 7 rejected implicit upcasting because "the
   vtables differ and the concrete type is erased". Both premises are about the conversion
   site, not about the program: the concrete type is known at every `dyn(...)` site, and codegen
   sees the whole program (`dyn_impls` is the whole-program registry that already lets
   `downcast` fold to a constant `.None`). So an upcast is implementable the way Rust implements
   `dyn Sub -> dyn Super`: the source vtable carries a pointer to each target vtable the program
   upcasts to.
   - **Surface:** `upcast(d, Dyn(Tgt...))` → `Dyn(Tgt...)`, the twin of `downcast(d, T)`. It is
     checked statically (the target's traits ⊆ the source's, after supertrait expansion), so it
     returns the Dyn, not an `Option`. Flow stays exact (`TYPE_IDENTITY.md`): the conversion is
     explicit, like every other representation change. `dyn(d)` of a value that is already a
     `Dyn` is an error pointing at `upcast` (`issues/fixed/dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c.md`).
   - **Lowering:** `{ .data = __yo_dyn_retain(d.data, d.vtable), .vtable = d.vtable->__yo_up_<Tgt> }`.
     The collection pass records every (source Dyn, target Dyn) pair; for every `dyn_impls`
     entry of the source it registers the (concrete, target) entry, so the target vtable exists,
     and the source vtable gets one `__yo_up_<Tgt>` slot per target. Retain/release stay per
     concrete payload, so the shared box is released by the right (atomic or plain) pair.
   - **Prerequisites (found by the audit, each its own issue):** one canonical trait order per
     `Dyn` (`issues/fixed/dyn-trait-order-is-part-of-its-c-type.md`); vtable slots keyed by (trait,
     method), with an ambiguity error for an unqualified call two traits supply
     (`issues/fixed/two-traits-sharing-a-method-name-in-one-dyn-emit-a-duplicate-c-wrapper.md`,
     `issues/fixed/a-method-call-two-trait-impls-supply-silently-picks-one.md`).
   - **Not covered:** a `Dyn` crossing a Yo static-library boundary, where the consumer cannot
     emit a vtable for a library-internal type; `downcast` has the same limit today.

   **Landed 2026-09-28** (branch `tss/dyn-upcast`): `upcast` as designed above, with its three
   prerequisites fixed — the canonical order sorts by trait id, not by the late-bound name (a
   `Dyn(SelfTrait)` sees its trait nameless; the name key split `tests/error_source_chain` into
   two C types on the first battery), E0616 covers both the `Dyn` slot clash and an unqualified
   call two trait impls supply (a census of every multi-candidate call in `check ./std` and
   `check ./src` found no genuine cross-trait ambiguity, so the rule rejects nothing there), and
   `dyn(d)` of a `Dyn` is an error naming `upcast`. Tests: `tests/dyn.test.yo` (31).

Exit: each issue's test flips; `check ./std` and `check ./src` are green with coherence enabled.

**Landed 2026-09-24: steps 1–3.** Conformance (E0602 "does not implement required trait … as
written", in `_c3_eval_colon_pair` and the default fill), `Impl(Trait)` bounds at results and arguments, and coherence
(`plans/reference/TRAIT_COHERENCE.md`, E0612). Step 3 needed step 3.3's module-qualified type ids
first — std had two live id collisions — so that part of 3.3 landed with it. The std fallout:
`HashSet(T)`'s duplicate `FromIterator`, and `std/fmt`'s blanket `Format` over `ToString` (which
overlapped every numeric impl) became a defaulted trait member with per-type impls.

### Phase 3: one notion of type identity (R4, R5)

1. **Define the predicate.** Write down in `plans/reference/TYPE_IDENTITY.md` which `TypeValue`
   variants are nominal (struct, enum, union, newtype, trait, `ref`/`atomic` wrappers) and which
   are structural (tuple with labels, fn with param modes and implicit params, array with length,
   pointer, `Dyn` with an exact trait set, SomeT by lineage). Make `are_types_compatible_exact`
   implement exactly that and nothing looser.
2. **Fix the loose relation.** In `src/types/compatibility.yo`:
   - an empty name is no longer a wildcard;
   - a name match without an id or field-wise match is not enough;
   - unions compare fields;
   - `Dyn` exact equality requires equal trait sets.

   Leave the deliberate coercions (the comptime numeric and string family, SomeT resolution) in
   the lenient relation and list them in the reference doc.
   (`struct-compatibility-accepts-a-name-match-or-an-anonymous-wildcard`)

   **Steps 1, 2 and 4 landed 2026-09-25.** `plans/reference/TYPE_IDENTITY.md` is the predicate:
   the identity relation per variant, and the closed list of coercions flow adds on top of it.
   Four changes in `src/types/compatibility.yo`:
   - The struct, enum and union arms stop treating an empty or equal name as proof.
   - The exact relation rejects a named-vs-anonymous pair, compares tuple labels, and requires
     equal `Dyn` trait sets.
   - Two empty ids are no longer "one id".
   - A mismatch between two types that print the same names each type's declaring module
     (`same_name_note`).

   Removing the wildcard exposed one stand-in it had been hiding: `Type.get_info` typed its
   `ComptimeList(VariantInfo)` from a value-reconstructed struct. It now uses the declared type.
   Step 4 needed no memo change beyond the relation itself, plus the id fast-path hardening
   (`issues/fixed/ctfe-memo-shared-struct-id-fast-path-smell.md`). The exit test "`Type.eq` is
   order-independent" is in `tests/type_soundness.test.yo`. Memo Repro 3 (fn parameter modes)
   moved to step 5.
3. **Module-qualified, position-independent ids.** Give `stable_type_id` and trait ids the module
   stem (`src/utils.yo` ~309). Key module-level declarations by module and name, not row/column,
   so a comment edit or file move no longer renames a C type. This is a byte-identity event:
   expect a pure renaming, re-record goldens, and run the fixpoint.
   (`trait-ids-omit-the-module-so-two-traits-can-share-one-id`,
   `a-two-line-comment-change-in-std-prelude-fails-check-std`)

   **Landed 2026-09-25.** The module half landed with Phase 2.3 (`stable_type_id` carries the
   module stem). The position half: every identity mint takes its position from
   `_anchored_position` (`src/utils.yo`). That is the enclosing top-level statement's label (its
   bound name, `impl_<receiver>` for an impl, or the previous label plus a count for an unnamed
   statement), the row offset from that statement's first line, and the column. The module walk
   registers the anchors (`register_module_anchors`, `src/evaluator/context.yo`) before anything
   in the module mints. It covers type, trait, declaration-position and function ids, and codegen
   temps and labels, which anchor on their token's own module. Measured: three comment lines added
   at the top of a program leave its emitted C byte-identical (68 differing lines before). The
   fixpoint and the full battery pass on the renamed ids. Moving a file into another directory
   still renames: the module stem is part of the key.
4. **The CTFE memo uses the identity predicate**, not exact compatibility
   (`ctfe-memo-merges-an-anonymous-struct-with-a-named-struct`,
   `ctfe-memo-shared-struct-id-fast-path-smell`).
5. **Param modes are part of fn types.** The evaluator distinguishes `fn(inout(x) : T)`,
   `fn(own(x) : T)` and `fn(x : T)`, completing Phase 1.9's codegen half
   (`inout-call-through-a-fn-value-loses-the-mutation`).

   **Landed 2026-09-25.** Both relations in `src/types/compatibility.yo` compare every parameter's
   `inout`/`own` flag, `-> inout(T)` and the implicit parameters; `type_to_string` prints the modes,
   which also makes them part of a fn type's codegen key. Impl conformance keeps the receiver's
   form free (`_with_receiver_mode_of`, `src/evaluator/values/impl.yo`), because the prelude and
   std implement `inout(self)` trait members with by-value receivers and Dyn wrappers adapt them.
6. **A bottom type.** Add `never`, the join identity for arms. Type `return`, `unwind`,
   `__yo_panic`, `std/assert.panic` and `exit` with it
   (`std-panic-cannot-type-a-value-arm-because-there-is-no-bottom-type`).

   **Compiler half landed 2026-09-25.** `never` is a type; it flows into every type and is the
   identity of a `cond`/`match` join. A diverging arm, or a body's diverging tail, adopts the type
   of its context (`adopt_never_type`), so codegen keeps a typed unreachable placeholder. A call to
   a `-> never` function runs as a statement. `__yo_panic` is `never` when nothing is expected of
   it. **The std half landed 2026-09-26**, once v0.2.43 put `never` in the seed (`yo build` compiles
   `std/` with the seed): `std/assert`'s `panic`, `std/process`'s `exit` and libc's `exit`, `_Exit`,
   `quick_exit` and `abort` are `-> never`. `return`/`unwind` keep their control-flow typing; they were already the join
   identity through the arm-join's control-flow rule, and retyping them bought nothing that was
   measured.
7. **Interning without the mutable cell.** Never intern a SomeT node, or leave its resolution
   cell out of the intern key and give each interned SomeT a fresh cell (`src/types/intern.yo`
   ~459). Phase 2.4 fixed every observable leak of the shared `resolved_concrete` cell where it
   arose, but it did not remove the cell; this step removes it, together with
   `g_some_resolved_concrete`.

   **Part 1 landed 2026-09-26: the cell is gone.** Measured first: in `tests/async_await.test.yo`
   alone the shared cells were overwritten 31 times with a different value, the registry once, and
   1074 resolutions were unregistered. A census of every writer and reader (225 sites) found:
   - Most resolutions were already set once, where the SomeT was built.
   - Two channels mutated shared cells in place: an opaque `Impl(...)` return's hidden type, and
     io.await's effect `E`.
   - The `set_resolved_concrete_type` synthesis channel that also wrote them was dead: nothing set
     it `true`.

   So:
   - The field is `resolution : Option(Self)`, an immutable value. A copy carries a snapshot, and
     a resolution learned later builds a new SomeT (`t_with_resolution`).
   - Interning a SomeT is sound because nothing can change an interned instance. The intern key
     already renders the resolution.
   - The opaque return's hidden type re-registers the function's type with a result carrying it
     (`t_with_func_result`). The id-keyed registry still records it for copies taken before.
   - io.await's `E` write is deleted: every async test passes without it, and an env binding in its
     place wrongly constrained a later bundle argument that only flows into `E`.
   - The dead channel is removed.
   - #939 already removed one shared-id registry write, `_resolve_some_types_deep`'s carrier
     registrations, which a second specialization read back.

   **Part 2 landed 2026-09-28** (branch `tss/p37-registry-v2`). `g_some_resolved_concrete` is
   gone and `some_resolution` reads only the value. The first build of the retirement broke
   compiled programs five ways (`check` stayed green). Each was measured and fixed at its cause
   (`issues/fixed/p37-registry-retirement-blocked-by-codegen-readers.md`):
   - `_resolve_some_types_deep` adopted a `Concrete(...)` wrapper's own resolution and split
     `Park` into two C structs. It now adopts a value's resolution only when the env rebound the
     slot to another SomeT.
   - A `(name, level)` substitution crossed binders that share a spelling (`map`'s and
     `filter`'s `F`). A SomeT's own resolution is now adopted by identity
     (`subst_adopt_own_resolution`), and a SomeT that carries a resolution is never rewritten by a
     name-keyed entry.
   - `stable_type_identity` rendered a SomeT by its binder spelling, which aliased two closures'
     capture structs.
   - The Fn-result pre-binding declared its variable with the result type instead of `Type`.
   - The deleted struct-field capture write was the only C type an `Impl(Fn)`-typed field got. A
     construction now instantiates the struct over the closure identity the field received.

   The writers, as landed:
   - io.async's future output carries the closure's concrete result
     (`_with_future_output_resolution`);
   - a closure value carries its capture struct as its wrapper's resolution
     (`closure_type.yo`);
   - the forwarded Future-wrapper param is a per-specialization REBUILD of the
     declared wrapper carrying the argument's wrapper, bound as the parameter's
     type (the capbind analog);
   - the shared-id Fn-bound result binder is a TYPE BINDING of the enclosing
     generic in the specialization's env, recording the binder it resolves
     (`_record_prebound_binder`, #939's mechanism) instead of a global write;
   - codegen's per-block result memo is its own map
     (`g_async_block_result_types`);
   - the Step-6 unregister loop, the await/Step-8 registry fallbacks and the
     "skip E" guard in `_resolve_some_types_deep` (it existed only because the
     registry was poisoned by prior IoExn registrations) are deleted.
8. **Unblocks** `plans/backlog/TYPEVALUE_HASH_CONSING.md`. Its measured blocker is "the intern key
   must equal codegen's `_type_key_at`". Once steps 1–4 make the evaluator's identity equal to
   the codegen key, hash-consing is a memory project, not a soundness risk. It is also where the
   evaluator-vs-codegen double-emission family closes
   (`option-of-a-trait-object-never-emits-its-inherent-methods`,
   `a-box-over-an-impl-fn-is-emitted-as-two-c-structs`,
   `a-generic-async-fn-whose-future-result-contains-t-emits-two-c-types`,
   `option-self-field-on-environment-splits-into-two-c-types` — no longer reproduces on develop
   `37045aa56` (fixed somewhere in the #939–#943 chain; measured with a develop-built binary,
   single-module and two-module controls; closed with a runtime gate in
   `tests/type_soundness.test.yo`). The neighbouring VALUE-struct shape had no indirection check
   at all and is fixed by the struct twin of the enum check
   (`issues/fixed/recursive-type-definitions-have-no-indirection-check.md`).

   **In progress 2026-09-26.**
   - `option-of-a-trait-object-…` is fixed. The identity callers (the specialization cache, the
     CTFE memo, `Type.eq`) and flow under a pointer shared one "exact" mode, so identity inherited
     a flow rule: a `Dyn` satisfies a SomeT's bounds, so an unconstrained `T` was "exactly"
     `Dyn(ToString)`. `_compat_impl` now has an `Identity` mode and an `Invariant` mode
     (`are_types_compatible_invariant`). The resolved-SomeT unwrap stays in identity, since
     `type_key` keys a resolved argument-slot SomeT by its resolution. Step 7 retires it.
   - `a-box-over-an-impl-fn-…` no longer reproduces on v0.2.43 (measured; moved to fixed).
   - `a-generic-async-fn-…` is fixed. The call's result, resolved through the specialization's
     env, was discarded whenever the rebuilt `Impl(Future(...))` wrapper was still a SomeT. All
     three call arms now share `_adopt_deep_resolution`.
   - Reducing it found `issues/fixed/a-caller-binder-named-t-collides-with-io-async-t.md`, a false
     E0601. A name and a frame level do not identify a type binder: the caller's `T` and
     `io.async`'s `T` share both. A binding now records the binder it resolves
     (`variable_bound_some_id`), and the resolver and `_bind_some_type` pair by it. Two defects
     behind it are fixed too:
     - a wrapper's deep resolution replaced the wrapper node through a same-keyed carrier;
     - it wrote a shared-id global registry entry that a second specialization read back. That is
       step 7's hazard, removed at this site.
   - The exit criterion's extern opaque is a nominal variant: `TypeValue.ExternOpaqueT(name,
     c_name)`, whose identity is the C spelling
     (`issues/fixed/an-extern-opaque-type-unifies-with-every-dyn.md`). It had been a `SomeT` with
     no bounds, so every generic-parameter rule applied to it unless the predicate at hand
     remembered to consult the `g_extern_type_names` side table; the table and every
     carve-out that read it are deleted. The variant implements `Runtime`, `Send` and `Acyclic` and not
     `Comptime` or `Rc`, and takes one coercion: a C scalar initializes it by value in flow, as C
     does (`atomic_bool` is built as `Self(false)`).
     Its reverse-direction canary found
     `issues/fixed/the-flow-relation-is-called-with-its-arguments-reversed.md`: the directional
     relation was called as (expected, actual) at the argument, binding and reassignment checks,
     so a `Dyn` downcast by reassignment passed `check`. **Fixed 2026-09-26** (branch
     `tss/flow-orientation`): all thirteen reversed sites pass `(actual, expected)`, `Dyn` flow is
     the exact trait set in every mode, and the flip exposed one more hole the reversal had
     masked — the extern-opaque C-scalar coercion composed into compound types (`Option(u64)`
     flowed into `Option(FILE)`;
     `issues/fixed/the-extern-opaque-scalar-coercion-composes-into-compound-types.md`) — fixed by
     moving the coercion to the relation's entry point.

9. **Array lengths by identity** (added 2026-10-01). `TypeValue.Array(element, length,
   length_var : String)` names a value-dependent length by SPELLING: `length_var = "U"` for an
   impl's const binder, `"T.BYTES"` for a projection. Substitution, synthesis and
   `_subst_resolve_len_projection` resolve those strings against whatever binders are current,
   so a length is captured by any other binder that has the same name. Measured: a
   `N := "T.BYTES"` binding read inside `fill`'s own impl (whose `T` is the element type) broke
   `tests/array.test.yo`. As a result `Array(u8, T.BYTES).fill(…)` cannot type in a generic
   trial and degrades to `unit` (`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`).
   Make the length a sum: a concrete count, a const binder by identity (the binder's SomeT
   lineage, like a type variable), or a projection of a SomeT's associated constant (the SomeT
   by identity plus the constant's name). Byte identity is expected to hold, since the C type of
   every concrete array is unchanged. After it lands, `mark_generic_independent` can drop its
   `unit` exclusion.

   **Design (written 2026-10-02 on `tss/option-of-generic-option-identity`; not implemented).**

   *Today.* `Array(element : Self, length : usize, length_var : String)`. `length_var` takes five
   shapes, told apart by spelling:

   | shape | written | example | minted by |
   | --- | --- | --- | --- |
   | concrete | `""` | `Array(u8, 4)` | `t_array` |
   | binder | the binder's name | `"U"` in `impl(generic(T, U : usize), Array(T, U), …)`; `"n"` for `fn(comptime(n) : usize) -> Array(i32, n)` | `evaluate_array_type`, atom branch |
   | projection | `"<recv>.<label>"` | `"T.BYTES"` | `_length_projection_text` |
   | computed | `COMPUTED_ARRAY_LEN_PREFIX` + the expression text | `"__yo_len_expr:(N + usize(1))"` | `evaluate_array_type`, fallthrough |
   | inferred | `"_array_length_<stable id>"` | `Array(i32, _)(1, 2, 3)` | `evaluate_array_type`, `_` branch |

   Four mechanisms resolve the binder and projection shapes by NAME. Each of them can be captured
   by another binder of the same spelling:
   - The synthesizer's `Array + Array` case (`evaluator/types/synthesizer.yo`, "Array LENGTH
     synthesis") binds `exp_lvar` in the expected env with `get_variables_from_env(ee, exp_lvar)` /
     `add_variable_to_env(ee, exp_lvar, …)`. It binds only when the given length is concrete, so an
     abstract receiver (`Array(u8, T.BYTES)`) leaves the impl's `U` unbound. That is the `unit`
     degrade of `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`.
   - `Substitution.len_var_names/len_var_values` (`types/substitution.yo`), filled by
     `subst_add_len_var` from the match's IntLit side channel (`values/impl.yo`,
     `g_last_match_binding_vals`). `_mask_func_own_binders` masks by name.
   - `_subst_resolve_len_projection` looks the receiver up with `_subst_lookup_by_name`, which
     ignores the frame level ("first match wins"). That is the capture that broke
     `tests/array.test.yo` when `N := VarRef("T.BYTES")` was tried.
   - The comptime-return resolver `_rlv` (`calls/function.yo`, "Resolve remaining ARRAY LENGTH
     VARIABLES") matches `rl_var` against the callee's parameter labels.

   *Representation.* A new enum in `types/definitions.yo`. It holds no `TypeValue`, so
   `TypeValue` does not become mutually recursive with it:

   ```rust
   ArrayLen :: enum(
     Count(n : usize),
     // A const binder (`generic(N : usize)`, `comptime(n) : usize`), by identity.
     Binder(id : String, name : String, level : usize),
     // `T.BYTES`: the SomeT `T` by identity, plus the constant's name.
     Projection(recv_id : String, recv_name : String, recv_level : usize, label : String),
     // Result types only. Re-evaluated in the callee's own env, never substituted.
     Computed(text : String),
     // `Array(T, _)`. Bound from the value at construction.
     Infer(id : String)
   );
   Array(element : Self, length : ArrayLen)
   ```

   - `id` is the binder's SomeT id. An impl-level value binder already has one: it is bound
     `TypeVal(SomeT)` in the impl's forall env, which is the "Family B re-kind" in
     `calls/function_type.yo`. In a def-time body env the binder is re-kinded to an unknown
     `usize` (the shadow binding in `_build_def_time_body_env`, and the fn-level `generic(N :
     usize)` loop beside it). That shadow binding records the binder with `variable_set_bound_some_id`, the
     mechanism #939 added for type binders, so `evaluate_array_type` reads the identity from the
     variable rather than from the token. A `comptime(n) : usize` parameter is not a forall
     binder. It gets the parameter's anchored declaration id (`_anchored_position`, Phase 3.3),
     recorded the same way.
   - `name`/`recv_name` are for display and diagnostics only. `type_to_string` keeps printing
     `Array(u8, T.BYTES)`, so every message and golden is unchanged.
   - `level` is what `subst_lookup` keys a SomeT by. A projection resolves exactly as a type
     variable is substituted, by (name, level) or the SomeT's own resolution.

   *Every site that reads or writes `length_var` today.* Positional `.Array(_, _, _)` patterns
   that ignore the length change mechanically. They are listed in step 1 below. The sites that
   interpret it:

   | site | today | after |
   | --- | --- | --- |
   | `types/creators.yo` `t_array`, `t_array_var` | `""` / a name | `Count(n)` / one constructor per variant |
   | `types/creators.yo` `COMPUTED_ARRAY_LEN_PREFIX`, `is_computed_array_len_var`, `_type_has_computed_array_len_d` | prefix test | `.Computed` |
   | `types/creators.yo` shell rewrite (`.Array(el, n, lv) => .Array(recur(…), n, lv)`) | pass-through | pass-through |
   | `types/substitution.yo` `.Array` arm, `subst_add_len_var`, `subst_lookup_len_var`, `_without_len_vars`, `_mask_func_own_binders` length half, `_subst_lookup_by_name`, `_subst_resolve_len_projection` | name-keyed | id-keyed (below); `_subst_lookup_by_name` deleted |
   | `types/string.yo` `.Array` arm | prints `lv` or `n` | prints `name` / `recv_name.label` / `n` |
   | `types/intern.yo` `.Array` arm | `A<el>#n#lv` | `A<el>#n`, `#B:<id>`, `#P:<recv_id>.<label>`, `#C:<text>`, `#I:<id>` |
   | `types/compatibility.yo` `.Array` arm | any variable length is compatible with anything | identity mode: equal `ArrayLen`; flow and lenient modes unchanged in this step |
   | `types/guards.yo` hard-generic classification | `hg_lvar.len() > 0` | not `.Count` |
   | `types/utils.yo` `_type_mentions_generic_length` | `lv.len() > 0` | not `.Count` |
   | `evaluator/types/array.yo` `evaluate_array_type`, `_length_projection_text` | mints the strings | mints the variants from the evaluated length (the binder's variable, the receiver's SomeT) |
   | `evaluator/types/synthesizer.yo` `Array + Array` | binds `exp_lvar` by name when the given length is concrete | see below |
   | `evaluator/values/impl.yo` spec binding (`subst_add_len_var(spec_s, sb_name, n)`) | by forall label | by the forall SomeT's id |
   | `evaluator/calls/function.yo` `_resolve_array_length_vars_from_self` | positional adopt | unchanged (positional) |
   | `evaluator/calls/function.yo` `_rlv` | label match | `Binder.id` match against the parameter's id |
   | `evaluator/calls/function.yo` `(alv.len() == 0)` concreteness test (~3385) | string test | `.Count` |
   | `evaluator/calls/helper.yo` `_type_has_array_len_var_d` | `alv_var.len() > 0` | not `.Count` |
   | `evaluator/calls/array_type.yo` (3 readers, 1 constructor) | string | variant |
   | `evaluator/exprs/binding.yo` the `_` annotation rejection | `starts_with("_array_length_")` | `.Infer` |
   | `evaluator/builtins/dup.yo`, `builtins/type_fns.yo` (`TypeInfo.Array`) | skip a non-concrete length | `.Count` |
   | `codegen/utils/index.yo` (C type of an array, and the length text ~2100) | `length_var.len() == 0` | `.Count(n)` |
   | `codegen/functions/declarations.yo` `_ret_has_len_var` | string | not `.Count` |
   | `codegen/exprs/drop_dup.yo` (2), `codegen/exprs/rc_fns.yo` (2), `codegen/exprs/array_fns.yo` fill | string | `.Count` |
   | `verifier/vc.yo` array sort | `lv.len() == 0` | `.Count` |

   *Substitution.* `len_var_names : ArrayList(String)` becomes `len_binder_ids : ArrayList(String)`,
   with `len_values : ArrayList(ArrayLen)`. The values are not only counts, so a trial can bind `U`
   to the receiver's abstract length (below). The `.Array` arm:
   - `Count` and `Computed` are left alone.
   - `Binder(id)` takes the bound value by id.
   - `Projection(recv_id, recv_name, recv_level, label)` substitutes the receiver as a SomeT would
     be substituted: `recur(s, <the SomeT>)` keyed by (name, level) or its own resolution. It
     reads the constant only when the result is concrete (`g_lookup_assoc_const`). If the result
     is another SomeT, the receiver is rewritten (`T.BYTES` becomes `T'.BYTES`). A wrong `T` is
     no longer reachable, because the lookup is the one every type variable already uses and it
     is level-aware. `_subst_lookup_by_name` is deleted.
   - `_mask_func_own_binders` masks length bindings by the nested fn's forall ids, not labels.
   - `_without_len_vars` is unchanged in meaning: nominal field types own their spelling, which
     is the `_ArrayIter` split it records.

   *Synthesis.* In the `Array + Array` case:
   - If the expected length is `Binder(id)` and `id` is one of the impl's or callee's forall
     binders, bind it. A concrete given length binds the count, as today. An abstract given length
     (`Binder`, `Projection`) binds the symbolic `ArrayLen`, and the binder's env variable stays
     an unknown `usize`, so the body's `while(i < U, …)` types.
   - The receiver's `Self` still comes from the receiver, so `Array(u8, T.BYTES).fill(u8(0))`
     types as `Array(u8, T.BYTES)` in the trial.
   - An expected binder that is not this match's own binder is left alone. That is the capture
     the name-keyed bind could not see.

   The value side (`g_last_match_binding_vals`) carries only concrete `IntLit`s. A symbolic
   binding goes into the substitution and never into an env value.

   *Migration order.* Each step builds, runs the fixpoint, and is gated on byte identity of the
   self-compile C. Only `Count` reaches codegen, and its rendering does not change.
   0. Measure. Count the distinct `length_var` values by shape over `check ./src`, `check ./std`
      and the fast suite (a `YO_DEBUG_*` probe in `t_array_var`). Confirm that every binder
      occurrence in a def-time body env is the re-kind shadow. If one is not, find its binding
      site before step 2.
   1. Change the representation, keeping name-keyed behaviour. Add `ArrayLen`. `Binder` and
      `Projection` carry the names, plus ids where the minting site has them. Rewrite every site
      in the table, plus the positional pass-throughs (`types/hierarchy.yo`,
      `types/utils.yo` walkers, `evaluator/types/enum.yo`, `trait_checking.yo`,
      `values/anonymous_function.yo`, `values/array.yo`, `calls/index_trait.yo`,
      `builtins/comptime_index_fns.yo`, `builtins/array_fns.yo`, `builtins/rc_fns.yo`,
      `effects/mutation_summary.yo`, `codegen/types/*`, `codegen/functions/constructors.yo`,
      `codegen/exprs/other_fn_call.yo`, `codegen/exprs/comptime_value.yo`,
      `evaluator/types/function.yo`). This is a pure refactor: identical C, identical goldens.
   2. Mint ids. Record the binder id on the re-kind shadow and on comptime value parameters, and
      mint `Binder(id)` and `Projection(recv_id)` in `evaluate_array_type`. Still byte-identical,
      since only the intern key's text changes.
   3. Make substitution id-keyed: the `.Array` arm, `subst_add_len_var` called with the forall
      SomeT's id in `values/impl.yo`, the masking by id, and `_subst_lookup_by_name` deleted. Run
      the reverted `tests/array.test.yo` `_Widthy` shape as the canary.
   4. Change synthesis: bind only the match's own binders, and bind an abstract given length
      symbolically. Exit test: `(out : Array(u8, T.BYTES)) = Array(u8, T.BYTES).fill(u8(0))` in a
      generic impl member checks in its definition-time trial (the table in the issue: `T.BYTES`,
      the alias `A`, and the local `n :: T.BYTES` rows). It also needs a two-binder canary: an
      outer impl `T` and `fill`'s own `T` in one call chain, at two different widths.
   5. Identity mode compares `ArrayLen`s in `compatibility.yo`, and `Type.eq` of
      `Array(u8, T.BYTES)` against `Array(u8, U.BYTES)` answers false. Then retry dropping the
      `unit` exclusion in `mark_generic_independent`. The later-impl degrade is fixed on
      `fix/enum-final-name`, so after this step the remaining blocker is whatever
      `check ./std` reports.

Exit: `Type.eq` answers are order-independent (a test runs the Repro 1 pair in both orders); the
byte-identity renaming check passes; the extern-opaque vacuous-trait-list rule
(`an-extern-opaque-type-unifies-with-every-dyn`) is replaced by a nominal opaque variant.

### Phase 4: diagnostics and codegen-only rules (R7)

1. **Every user-reachable ICE becomes an evaluator error with a code.** Move the async rules
   (the four in `user-facing-async-restrictions-reported-as-internal-compiler-error` plus the
   two added 2026-09-23) and `io-await-on-a-join-handle-…` into the evaluator's `io.async` walk.
   Fix the dead `.AsyncBlock` check in `initialization_assignment.yo`.

   **Landed 2026-09-25.** The splitter's rules are user errors: `codegen_user_error`
   (`src/codegen/constants.yo`) reports them at the user's token with a code, a caret and
   `--error-format` support, instead of the internal-compiler-error banner. `inout(name) :=` in
   an awaiting `io.async` body is checked by the evaluator (`first_inout_binding_in_async_body`),
   so `check` sees it; the dead `.AsyncBlock` branch was that rule's only home. E0904 names the
   placement family again, and a typo in an async body is E0905. `io.await` on a `JoinHandle` was
   already rejected with E0602 before this step; its anchor is Phase 4.4's.
2. **An FTT stub reachable from any live function is a compile error**, not only in
   `__yo_user_main`. This turns every remaining R2 hole into a loud failure while Phase 6
   removes them.
3. **Field and member errors.** A coded "no field `xx` on P (fields: x, y)" with did-you-mean
   (`unknown-struct-field-has-no-diagnostic`).

   **Landed 2026-09-25.** A field read that names no field is E0406 with the field list and a
   did-you-mean, everywhere, including inside arithmetic (which used to pass `check`). A dot
   expression that is a call's callee is still a method lookup (`mark_dot_callee`).
4. **Anchoring and codes.** Report at the outermost user frame with a "required by" note into
   std; one code per mistake class; register every uncoded error; carry argument tokens into the
   call-site check; remove internal names from user text
   (`type-error-diagnostics-point-into-std-and-use-inconsistent-codes`,
   `diagnostic-codes-are-assigned-by-substring-matching-the-message-text`).

   **Landed 2026-09-25.** Three mechanisms:
   - A call written in user code reports an error raised inside std at itself, with the std
     location as a note (`evaluate_function_call` traps the error when the call's module is not
     std; `reanchor_primary_at`).
   - The flow-violation channel holds the thrown `YoError`, so a definition-time re-raise keeps
     the raise site's span, code and notes instead of the enclosing function's `{`.
   - Raise sites name their code (`with_code`). E0401's sites do, and the loose "not found"
     substring rule that mis-coded destructuring labels, trait fields and internal errors is
     deleted; the other families still fall back to the classifier until converted.

   New codes: E0615 (argument label mismatch) and E1103 (compile-time division by zero). E0606
   widened to "value is not callable". All 16 findings of the issue are resolved (its table). Found
   on the way and fixed: a `::` over a `cond`/`if` with a runtime condition passed `check`
   (`issues/fixed/a-comptime-binding-accepts-a-cond-over-a-runtime-condition.md`).
5. **Match usefulness as warnings.** Per-arm usefulness through the landed warnings channel
   (#846), interval reasoning for ranges, precise witnesses
   (`match-redundancy-and-range-exhaustiveness-gaps`). Coordinate with the P4 step of
   `plans/reference/MATCH_PATTERN_MATCHING.md`.

   **Landed 2026-09-26.** `src/pattern.yo`, reported from `evaluator/exprs/match.yo`:
   - **Integer intervals.** At a fixed-width integer position, constants and ranges are intervals
     of 64-bit keys, with the sign bit flipped for signed types. Constructor splitting decides
     exhaustiveness, so `(0..=255)` covers `u8` and a gap is the witness (`(101 ..= 149)`).
     `usize`/`isize` differ per target and still need a catch-all.
   - **Per-arm verdicts (`arm_reachability`).** An arm no value matches (an empty range, a
     GADT-excluded variant) and an arm one earlier arm or or-alternative covers are errors (E0608).
     An arm the earlier arms cover only together is a warning. A trailing catch-all is always
     accepted.
   - **Witnesses.** A missing variant renders its payload (`.Circle(_)`), and the E0607 help says
     when a guard leaves the value unmatched.

   Found and fixed on the way: a repeated or-alternative was accepted; a GADT-excluded variant's
   partial arm made E0607 demand an impossible case.

Exit: `grep -c codegen_fatal` over paths reachable from user source is tracked and falling; no
Phase 0 corpus program produces "internal compiler error".

### Phase 5: ownership and thread safety (R8)

Each item starts with a short decision recorded in `plans/reference/` because each changes what
safe code may write.

**Items 3 and 4 are owned by [`PARALLELISM_SOUNDNESS.md`](archive/PARALLELISM_SOUNDNESS.md)** (2026-09-25,
agreed between the two sessions): the parallelism audit found the same two holes plus the rest of
the thread-safety surface, and fixes them in its Phases 2 and 3 with the reference decisions there.
Items 1, 2, 5 and 6 stay here.

1. **Loop-carried moves.** A variable consumed in a loop body and not re-assigned before the back
   edge is an error (`moving-a-variable-inside-a-loop-body-is-not-rejected`).
2. **`inout` exclusivity.** An `inout` argument may not share a root with any other argument,
   or the other argument is dup'd. Correct `flowability.yo`'s and FLOWABILITY.md's "by-value
   overlap is safe" (`borrowed-arg-invalidated-by-aliased-container-mutation` addendum).
3. **Globals and `Send`.** Recommended rule: a module-level runtime binding must be `Send`-safe
   (atomic, a `Mutex`, or immutable); anything else is a compile error
   (`module-globals-bypass-send-so-safe-code-can-data-race`).
4. **`Iso` deep uniqueness.** Either bound `Iso(T)` on an interior-`Send` `T`, or verify
   refcount 1 on every reachable ref at construction
   (`iso-checks-only-the-wrapper-refcount-not-the-interior`).
5. **Control-bound values in ref fields.** Run `type_is_control_bound` on every
   `ref(...)`/`atomic(...)` field type at definition
   (`ctl-handler-stored-in-a-ref-struct-field-escapes-its-frame`,
   `module-level-control-bound-binding-not-rejected`).
6. **Definite initialization.** Make E0903 fire (`cond-arm-initialization-merge-check-never-fires`).

**Items 1, 2, 5, 6 landed 2026-09-25**; the first full battery (2026-09-26) found and fixed four
things:
- The compiler kept `Exception` handlers in two typed module globals, which item 5 now rejects.
  The loader and codegen return errors as values instead
  (`issues/fixed/the-compiler-keeps-exception-handlers-in-module-globals.md`).
- The loop ways-out check (E0907) is limited to values with a drop.
- A returning arm's move, undone for the code after the branch, was released again at the
  arm's own `return`. Undone moves are now kept per arm for codegen's cleanup points
  (`issues/fixed/a-move-in-a-returning-arm-is-released-again-at-the-return.md`, caught by
  running the Phase 5 test binaries under `libgmalloc`).
- The E0907 registry example was fixed.

Also found in the Phase 4/5 battery: a field write through a borrowed value binding released
data its owner still held. It is E0908
(`issues/fixed/a-field-write-through-a-borrowed-value-binding-double-releases.md`).

- **The flow log (1, 6).** Every assignment and every move of a user-named variable is logged with
  its init and move state before and after. A `cond`/`match` arm starts from the state before the
  branch (`reset_sibling_flow_state`). `Variable` is one shared object per binding, so an arm used
  to see its siblings' assignments and moves. A join reads each arm's end state from the log,
  counting only the arms that reach it.
- **The rules this enables.**
  - E0903 fires.
  - A partial move at a join is E0907 (new).
  - A runtime loop checks that no value live at entry is moved on a way back to its condition
    (E0901).
  - It also checks that its ways out (the condition, each `break`) agree on what is moved
    (E0907).
  - A move in a returning arm no longer poisons the code after the branch.
- **Aliasing (2).** A by-value argument that is the variable another argument passes `inout` gets
  a `+1` for the call. FLOWABILITY.md is corrected.
- **Control-bound fields (5).** `ref`/`atomic` structs and enums reject control-bound fields at
  definition. Module-level typed bindings are checked for control-bound types like the `:=` form.

Exit: each repro is rejected; a sanitizer run of the Phase 5 corpus under `--sanitize address`
is clean for the accepted variants.

### Phase 6: retire the swallow policy (R2)

The largest and last phase, because Phases 1–5 shrink it.

1. Classify every trial-evaluation swallow site (`_trial_eval_anon_body`, the named-fn def-eval
   trial, the anonymous-module trial, the derive guard) by why it swallows. Legitimate reason: a
   body that cannot be typed until a SomeT is resolved at a call. Illegitimate: anything else.
2. A swallowed error whose context has no unresolved SomeT is re-raised immediately. The
   named-fn path already does this through `g_trial_swallow_msg`; generalize it.
   **Closure bodies landed 2026-09-27** (branch `tss/p6-closure-reraise-v2`): a closure whose
   parameters are all concrete runtime values re-raises its swallowed error with the structured
   diagnostics. A `comptime(x)` value parameter makes the body call-dependent, exactly as the
   named-fn path's `ft_has_ct_param` does: the prelude's `to_comptime_string : (self ->
   __yo_expr_to_string(self))` checks against `fn(comptime(self) : Self)` and was the false
   positive that blocked the first build. (A first fix classified that error by a new code,
   E1104; it was replaced by the parameter rule, which is the actual reason.) Sites #2/#6
   (the deferred-generic trials) still need the "does the error involve a SomeT?" refinement.
   **Sites #2/#6, #4, #14, #15 (2026-09-27, branch `tss/p6-generic-reraise`).** A mismatch
   between two types with no type variable in them is marked `generic_independent` on its
   primary diagnostic (`mark_generic_independent`, `types/utils.yo`; set by the synthesizer's
   four unify failures, the argument rule and the GADT arm check), and the deferred-generic
   trials of fns (#2) and closures (#6) and the specialization-time closure re-eval (#15)
   re-raise exactly those — no instantiation can fix them. A trait default that fails for a
   concrete `Self` and a variable-free signature is the impl's error (#14). The forward
   comptime-fn re-run reports a body that still fails once every forward declaration it waited
   for is filled (#4, `issues/fixed/a-forward-comptime-fn-body-error-is-dropped-by-the-pending-rerun.md`).

   **Landed 2026-09-28** (branch `tss/p6-generic-reraise`, with sites #2/#4/#5/#6/#14/#15 above):
   the deferred-generic trials run for EVERY generic fn and closure (a diagnostic-only trial on a
   fresh-id clone, so it never stamps nodes codegen reads); a `comptime(x)` value parameter
   defers a generic body's judgment to its calls; `mark_generic_independent` also refuses a
   value-dependent array length and the `unit` stand-in
   (`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`). 116 of the 123 site-#16
   calls propagate the sub-expression's own error (`evaluate_expression_raw`, or the new
   `evaluate_expression_guarded` where ctx state is restored first). The seven left are the two
   deliberate probes, `match`'s scrutinee (already retried raw), and four debug/introspection
   builtins that no-op on failure (`var_fns.yo` ×3, `comptime_assert.yo`'s validation-mode
   check). Re-raising surfaced two latent bugs, fixed at their cause: a trait default was
   materialized in the implementing module's scope
   (`issues/fixed/a-trait-default-is-materialized-in-the-implementing-modules-scope.md`) and
   evaluated raw, so a bare `return(...)` default failed.

   **Site #16 census (2026-09-27, develop `862cfc5bb`).** 123 calls of the 3-argument
   `evaluate_expression` (the per-node swallow), all in `src/evaluator/`, every one with an `exn`
   in scope. 58 already recover the real cause (`format_eval_failure` reads the
   swallowed-cause channel); 59 lose it — a generic or wrong message, or a silent degrade; 2 are
   deliberate probes (`pattern_compile.yo` `_bind_subject_and_eval_test`,
   `index_trait.yo` `_try_comptime_custom_type_index`); 4 silently no-op (`var_fns.yo` ×3,
   `comptime_assert.yo`'s validation-mode check). Converting a site to
   `evaluate_expression_raw(…, exn)` needs no extra ExprInfo bridging (both wrappers bridge) but
   does need two things: a site that saves/restores ctx state around the call must restore on
   the throw path too (the stash-then-rethrow shape of `_derive_eval_guarded`), and the raw
   wrapper's safe-code raw-pointer gate now applies to it. Highest value first: the `<:`
   operands, `the`, `typeof`, associated-type constraints, `Type` reflection builtins, match
   guards and atom `cond` conditions, the shared comptime-argument helpers, `Future` effect
   arguments, `derive`'s target type, and `comptime_expect_error`'s expected-text argument
   (a failing one silently accepts ANY error — a test-soundness hole).
3. A swallowed error that *is* SomeT-pending is recorded against the specialization and
   re-raised when the specialization with concrete types fails, with the call site as a note.
   The trial does not treat distinct binders as rigid. A body that unifies `T` with `S`, for
   example by passing `*T` and `*S` to one callee binder `U`, or by returning `a : *T` as `*S`,
   records no error at all. Only a concrete specialization with `T != S` rejects it (measured
   2026-10-01,
   `issues/fixed/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`).
   This matches the monomorphizing model in §1, and this step adds nothing for that case.
   **Landed 2026-10-02** (branch `tss/phase6-reraise`). The census came first
   (`TYPE_SYSTEM_SOUNDNESS_HANDOVER.md` §3.2). It found that a concrete specialization's
   failure is not swallowed: it reaches the caller and is reported. It also found that no
   specialization a call requested ends up as an FTT stub in the fast suite's 311 batches.
   Step 3 is therefore two parts. First, the error a failing specialization raises carries a
   note at each call that instantiated it (``in `f` with T = i32, instantiated here``).
   Second, a SomeT-pending trial error is recorded against its body, and codegen reports it
   for a requested specialization that does reach emission hollow, instead of writing a stub.
   Step 3 surfaced two bugs, both fixed: a generic forwarding its binder to an operator
   generic was rejected against its own `U`, and an operator `unit` has no impl for passed
   `check` in concrete code.
4. Phase 4.2's "any reachable FTT stub is an error" becomes the backstop and should never fire.

Exit: the Phase 0 swallow census for real type errors is zero on `./std` and `./src`; FTT
stubs are gone from the emitted C of the whole fast suite.

### Phase 7: documentation sync

Correct the docs the audit found stale, in `docs/en-US/` and `docs/zh-CN/` both:

- `DYN_DESIGN.md`: object safety "enforced at method call time" is false until Phase 2.7 lands;
  its examples use `inout(self)` while `tests/dyn.test.yo` uses `self : *Self`. (Done with 2.7:
  the rules section is rewritten and names every receiver form.)
- `DESIGN.md` §Pattern Matching ("an arm no value can reach is an error") and §GADT
  (refinement and index filtering).
- `GADTS.md`: "No nested destructuring" is stale since match P1–P3; the refinement description
  must match Phase 1.1.
- `ISOLATED.md`: still describes the TypeScript-era model; `THREAD_SAFETY.md`: "sharing
  unsynchronized state across threads is a compile error".
- `FLOWABILITY.md`: "By-value overlap is fine too".
- `MEMORY_SAFETY.md` and `DESIGN.md` (~1475): say the borrowed `for(xs, inout(x) => ...)` form
  was removed; it works.
- `ERROR_DIAGNOSTICS.md`: "the same underlying mistake always produces the same code".
- `.github/instructions/yo-syntax.instructions.md`: the `-fwrapv` wrap-around rule predates the
  overflow traps (#837).
- `plans/archive/THREAD_SAFETY.md` row 17 (mutable statics): add a correction banner rather than
  rewriting the archive.

Each phase also updates these docs for the rules it adds.

**Status 2026-09-25.** Done:
- `DYN_DESIGN.md` (with 2.7).
- `DESIGN.md` §Pattern Matching: the unreachable-arm rule is true now (E0608); verified with a
  repeated `.A` arm.
- `GADTS.md`: nested patterns are documented as working, and the refinement text matches Phase 1.1
  and names the open generic-arm issue.
- `ISOLATED.md`: rewritten by the parallelism audit.
- `MEMORY_SAFETY.md` and `DESIGN.md`: they now document the working `for(coll, inout(x) => ...)` form
  instead of calling it removed; verified, `x = x + 10` writes the element.
- `ERROR_DIAGNOSTICS.md` and the `-fwrapv` note.
- The archive banner for row 17.

Open: none.

- `FLOWABILITY.md`'s "by-value overlap is fine too": closed with Phase 5.2 — the doc now records
  the landed rule (a by-value argument that overlaps an `inout` one is dup'd for the call).
- `THREAD_SAFETY.md`'s "sharing unsynchronized state across threads is a compile error": settled
  by `plans/archive/PARALLELISM_SOUNDNESS.md` (archived COMPLETE 2026-09-26) — the guarantee
  holds with an empty Known Holes list and rules D1–D9 behind it.

## 6. Order and sizing

| Phase | Depends on | Size | Why this position |
| --- | --- | --- | --- |
| 0 | – | S | gives every other phase a metric |
| 1 | 0 | S–M, 9 independent PRs | the critical GADT hole and most "compiles and runs wrong" cases, each one site |
| 4.1–4.2 | – | S | turns silent holes loud immediately; can run in parallel with 1 |
| 2.1–2.3, 2.7 | 0 | M | conformance and coherence decisions |
| 2.4–2.6 | 1 | L | the architectural unification change |
| 3 | 2.4 | L | identity needs the cell gone; byte-identity event |
| 5 | 0 | M, 6 decisions | independent of 2–3; can run in parallel |
| 4.3–4.5 | 1 | M | diagnostics polish |
| 6 | 1–5 | L | shrinks as the others land |
| 7 | each | S | per phase |

## 7. Measurement provenance

The six audit parts were run against develop `7e0187d59` with the v0.2.39 seed. Probes that the
audit marks MEASURED were run with `yo check` and, where check was green, `yo compile
--optimize 2` and the binary.

All 46 reproducers behind the new issues and addenda were then replayed on a compiler built from
develop `d455b6a67` (with `YO_STD` pointing at the tree's std, because `yo build` otherwise
compiles `src/` against the seed bundle's std). Every one still reproduces. Three differ from the
seed in detail, and each doc says how:

- The `inout` fn-value probes print the right numbers on develop, but both compilers emit the
  same truncating cast, so that output is undefined behaviour that happens to work.
- The GADT wrong-index program prints `1` instead of `0`; the value is unspecified.
- The cross-module anonymous-id probe needed rebuilding, because the audit's copy used
  `bool(true)` inside a record, which fails under both compilers with an internal "Phase 5"
  message (added to the diagnostics issue).

Each new issue doc carries its own "Measured" line. Findings marked READ come from reading code
and give file and approximate line numbers; line numbers drift, so the function name is the
durable anchor.
