# Type system soundness: make `yo check` a gate, not a filter

**Status:** ACTIVE, proposed 2026-09-23. Phases 0, 1, 2.1–2.4 LANDED 2026-09-24/25 (the
per-phase "Landed" notes below); 2.5–7 open. Source: a six-part audit of the type system on
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
| move an `ArrayList` into an `own` param inside a `while` | use-after-free, prints garbage | `issues/moving-a-variable-inside-a-loop-body-is-not-rejected.md` |
| call an `inout` fn through a fn value | the pointer is truncated to `int32_t`; the seed's binary loses the mutation | `issues/inout-call-through-a-fn-value-loses-the-mutation.md` |
| push to a module-global `ArrayList` from two threads | data race, contract failure | `issues/module-globals-bypass-send-so-safe-code-can-data-race.md` |
| `Iso` a wrapper whose interior is aliased | data race | `issues/iso-checks-only-the-wrapper-refcount-not-the-interior.md` |
| `apply(x => true, 3)` where `Fn(x : i32) -> i32` is expected | prints `1` | `issues/fixed/closure-result-type-is-not-checked-against-the-expected-fn-type.md` |
| `pair_same(String, i32)` with `fn(generic(A), x : A, y : A)` | runs | `issues/fixed/generic-type-var-rebinds-per-argument.md` |
| `Wrap(fn(x : i32))` then `Wrap(fn(inout(x) : i32))` | SIGSEGV | `issues/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md` |

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
wrong check-time error, see `issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md`),
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
open (Phase 6): `issues/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`.

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
6. **Associated types in free-fn `where`.** Execute `plans/backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`
   on top of step 4, because both are about binding a variable from a bound.
7. **Dyn object safety in the evaluator.** Reject, with a code, trait members whose signature
   mentions `Self` outside the receiver or takes `generic(...)` binders, when forming `Dyn(Trait)`
   or calling through it. Decide whether upcasting `Dyn(A, B)` to `Dyn(A)` is supported.
   (`dyn-object-safety-is-not-enforced-before-codegen`,
   `blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable`)

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
3. **Module-qualified, position-independent ids.** Give `stable_type_id` and trait ids the module
   stem (`src/utils.yo` ~309). Key module-level declarations by module and name, not row/column,
   so a comment edit or file move no longer renames a C type. This is a byte-identity event:
   expect a pure renaming, re-record goldens, and run the fixpoint.
   (`trait-ids-omit-the-module-so-two-traits-can-share-one-id`,
   `a-two-line-comment-change-in-std-prelude-fails-check-std`)
4. **The CTFE memo uses the identity predicate**, not exact compatibility
   (`ctfe-memo-merges-an-anonymous-struct-with-a-named-struct`,
   `ctfe-memo-shared-struct-id-fast-path-smell`).
5. **Param modes are part of fn types.** The evaluator distinguishes `fn(inout(x) : T)`,
   `fn(own(x) : T)` and `fn(x : T)`, completing Phase 1.9's codegen half
   (`inout-call-through-a-fn-value-loses-the-mutation`).
6. **A bottom type.** Add `never`, the join identity for arms. Type `return`, `unwind`,
   `__yo_panic`, `std/assert.panic` and `exit` with it
   (`std-panic-cannot-type-a-value-arm-because-there-is-no-bottom-type`).
7. **Interning without the mutable cell.** Never intern a SomeT node, or leave its resolution
   cell out of the intern key and give each interned SomeT a fresh cell (`src/types/intern.yo`
   ~459). Phase 2.4 fixed every observable leak of the shared `resolved_concrete` cell where it
   arose, but it did not remove the cell; this step removes it, together with
   `g_some_resolved_concrete`.
8. **Unblocks** `plans/backlog/TYPEVALUE_HASH_CONSING.md`. Its measured blocker is "the intern key
   must equal codegen's `_type_key_at`". Once steps 1–4 make the evaluator's identity equal to
   the codegen key, hash-consing is a memory project, not a soundness risk. It is also where the
   evaluator-vs-codegen double-emission family closes
   (`option-of-a-trait-object-never-emits-its-inherent-methods`,
   `a-box-over-an-impl-fn-is-emitted-as-two-c-structs`,
   `a-generic-async-fn-whose-future-result-contains-t-emits-two-c-types`,
   `option-self-field-on-environment-splits-into-two-c-types`).

Exit: `Type.eq` answers are order-independent (a test runs the Repro 1 pair in both orders); the
byte-identity renaming check passes; the extern-opaque vacuous-trait-list rule
(`an-extern-opaque-type-unifies-with-every-dyn`) is replaced by a nominal opaque variant.

### Phase 4: diagnostics and codegen-only rules (R7)

1. **Every user-reachable ICE becomes an evaluator error with a code.** Move the async rules
   (the four in `user-facing-async-restrictions-reported-as-internal-compiler-error` plus the
   two added 2026-09-23) and `io-await-on-a-join-handle-…` into the evaluator's `io.async` walk.
   Fix the dead `.AsyncBlock` check in `initialization_assignment.yo`.
2. **An FTT stub reachable from any live function is a compile error**, not only in
   `__yo_user_main`. This turns every remaining R2 hole into a loud failure while Phase 6
   removes them.
3. **Field and member errors.** A coded "no field `xx` on P (fields: x, y)" with did-you-mean
   (`unknown-struct-field-has-no-diagnostic`).
4. **Anchoring and codes.** Report at the outermost user frame with a "required by" note into
   std; one code per mistake class; register every uncoded error; carry argument tokens into the
   call-site check; remove internal names from user text
   (`type-error-diagnostics-point-into-std-and-use-inconsistent-codes`,
   `diagnostic-codes-are-assigned-by-substring-matching-the-message-text`).
5. **Match usefulness as warnings.** Per-arm usefulness through the landed warnings channel
   (#846), interval reasoning for ranges, precise witnesses
   (`match-redundancy-and-range-exhaustiveness-gaps`). Coordinate with the P4 step of
   `plans/MATCH_PATTERN_MATCHING.md`.

Exit: `grep -c codegen_fatal` over paths reachable from user source is tracked and falling; no
Phase 0 corpus program produces "internal compiler error".

### Phase 5: ownership and thread safety (R8)

Each item starts with a short decision recorded in `plans/reference/` because each changes what
safe code may write.

**Items 3 and 4 are owned by [`PARALLELISM_SOUNDNESS.md`](PARALLELISM_SOUNDNESS.md)** (2026-09-25,
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

Exit: each repro is rejected; a sanitizer run of the Phase 5 corpus under `--sanitize address`
is clean for the accepted variants.

### Phase 6: retire the swallow policy (R2)

The largest and last phase, because Phases 1–5 shrink it.

1. Classify every trial-evaluation swallow site (`_trial_eval_anon_body`, the named-fn def-eval
   trial, the anonymous-module trial, the derive guard) by why it swallows. Legitimate reason: a
   body that cannot be typed until a SomeT is resolved at a call. Illegitimate: anything else.
2. A swallowed error whose context has no unresolved SomeT is re-raised immediately. The
   named-fn path already does this through `g_trial_swallow_msg`; generalize it.
3. A swallowed error that *is* SomeT-pending is recorded against the specialization and
   re-raised when the specialization with concrete types fails, with the call site as a note.
4. Phase 4.2's "any reachable FTT stub is an error" becomes the backstop and should never fire.

Exit: the Phase 0 swallow census for real type errors is zero on `./std` and `./src`; FTT
stubs are gone from the emitted C of the whole fast suite.

### Phase 7: documentation sync

Correct the docs the audit found stale, in `docs/en-US/` and `docs/zh-CN/` both:

- `DYN_DESIGN.md`: object safety "enforced at method call time" is false until Phase 2.7 lands;
  its examples use `inout(self)` while `tests/dyn.test.yo` uses `self : *Self`.
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
