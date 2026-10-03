# Type-system soundness: handover

**Status:** updated 2026-10-04, at the end of a stretch (yo-74/yo-e2). The plan is [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md);
it stays authoritative for what each phase means. This doc says where the work stands and what
to do next (§3.0 is the ordered list). Move it to `archive/` with a banner once §3 is empty.

## 1. Where the plan stands

| Phase | State |
| --- | --- |
| 0 ratchet, 1 missing comparisons | Landed. |
| 2 traits and generics | Landed, including 2.8 explicit Dyn upcast (#965). |
| 3 type identity | Landed through step 8. Step 9 (array lengths by identity) started: design in the plan, step 0 (census probe) landed (#1149); steps 1–5 open (§3.0). |
| 4 diagnostics | 4.1, 4.3, 4.4, 4.5 landed. 4.2 lands as Phase 6 step 4. |
| 5 ownership | Landed (3 and 4 via `archive/PARALLELISM_SOUNDNESS.md`). |
| 6 swallow policy | Steps 1–3 landed (#968, #1062, #1124). Site #8 landed (#1113). Step 4 is PR `tss/phase6-step4` (§3.0). |
| 7 docs | Done; each phase updates its docs as it lands. |

## 2. Landed in this stretch

**2026-10-01 → 2026-10-04:**

- #1088 docs; #1094 impl forcing (recursive-type list elements, name-aware guard, declaring-only
  named misses, never an importer parked on its import); #1105 develop's own runtime `?=` field
  defaults (#1098 broke the self-compile); #1104 a generic callee's binder nested in a type binds
  from the caller's binder in a trial (extern and Yo-fn routes); #1113 `check` sees other
  modules' function bodies (Phase 6 site #8); #1112 `EnumT.type_arguments` (phantom enums;
  its async regression fixed by #1121); #1124 Phase 6 step 3; #1135 `__yo_v_` C identifiers
  (header-macro collisions); #1116 `wrap(wrap(x))` type identity + the step-9 design; #1149
  step-9 step 0 (`YO_DEBUG_ARRAY_LEN`); #1144 (issue: no test run timeout).

**2026-09-29 → 2026-10-01:**

- **#996:** develop builds with the v0.2.45 seed again (the value `JoinHandle`, lowered by
  the handle's type). Released as v0.2.46. Fixed on the way: the escape-after-branch double drop,
  #993's `recur` escape check (seed-safe `compile_pattern`), and #993's exhaustiveness blow-up
  (compile of the compiler 654 s → 172 s).
- **#975:** the id-keyed SomeT registry is retired; resolutions travel on the value.
- **#1022:** the type-universe walk and the raw-pointer/slice-source predicates memoize shared
  subtypes by type object. A depth-64 struct DAG checks in 0.8 s. The predicates' depth-40 cap
  was a false negative (a pointer 40+ levels down read as absent) and is now a cycle guard by
  object identity.
- **#1051:** four Windows-recorded LSP goldens and the wasm32 owner-prefix test.
- **#1062 (the stack):** stream-combinator type identity (a combinator repeated in one chain);
  impl-member ordering (an operator miss forces pending impls; trait-constructor members are
  pending inner fields; a `ref(enum)` never folds to a nullable pointer); the Phase 6 census
  fixes (test-body trials validate like function bodies; auto-boxed `dyn` node ids; comptime
  float → int; the `Var` builtins propagate errors, require an identifier, and emit their
  answer at run time). Two WIP commits were reverted when first built (§3.3).
- **v0.2.46 and v0.2.47** released.
- **#1072:** a compiler built by v0.2.47 segfaulted in `unsafe-report`, `public-safe-report`
  and `update --latest`. #1018's state-machine move-out zeroed a slot when the dup/drop pair
  optimizer cancelled a store the local goes on reading. In a block that awaits, a local's move
  is no longer cancelled; the alias elision stays.
  `issues/fixed/a-cancelled-dup-drop-pair-zeroes-a-state-machine-slot-still-read.md`. Any
  program v0.2.47 compiled with that shape is affected, so the next patch release should carry
  it.

## 3. Open work, in order

### 3.0 Next, in order

1. **Phase 6 step 4 / Phase 4.2** (branch `tss/phase6-step4`, PR against develop): a live
   failed-to-transpile stub (not a superseded generic original) is a compile error, reporting
   the trial's recorded error or the stub site with the `YO_DEBUG_SWALLOW` hint. Prerequisite
   in the same PR: a function written inside a `comptime_expect_error(...)` argument is never
   emitted (`should_skip_function_codegen` + `is_inside_cee_argument`; those were the only 14
   live stubs in the fast suite). Red-before shown with a build that has the stub rule but not
   the skip: `tests/type_soundness.test.yo`'s batch fails with the new error. If it has not
   landed, finish its battery (fast suite included) and merge.
2. **Phase 3 step 9, steps 1–5** (the plan's migration order): `ArrayLen` replaces the
   `length_var` string (pure refactor, byte-identical), then ids, id-keyed substitution
   (`_subst_lookup_by_name` deleted; the `tests/array.test.yo` `_Widthy` canary), symbolic
   synthesis (exit test: `Array(u8, T.BYTES).fill(u8(0))` checks in a generic impl member's
   trial), identity-mode comparison, then drop `mark_generic_independent`'s `unit` exclusion.
   Step 0's census: `src`/`std` mint only `N`, `U` and `T.BYTES`. Still to do for step 0: the
   fast-suite share and the re-kind-shadow confirmation.
3. **The kept-swallow kinds** (§3.2 "What remains" 2): most are an operator on an
   unconstrained binder typed as `unit` (`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`).
4. Smaller, each about a day or less:
   - `issues/enum-type-arguments-made-check-about-4-percent-slower.md` (S3, #1112's cost; filed
     by #1121 — read its suspects first).
   - Make strict test-body checking the default (§3.3), after comparing the
     `closure_param_forwarding` memory peak and the `imm_*` SIGBUS against develop.
   - `issues/yo-names-with-a-leading-underscore-are-emitted-bare-and-can-hit-header-macros.md` (S3).
   - `issues/a-hung-test-binary-blocks-yo-test-forever.md` (S3): a per-batch run deadline.

**How this stretch gated** (see §4): one worktree per branch under `~/Workspace/Yo-wt`; never two
`yo test` runs in one worktree (batch files collide); long legs (`fixpoint_only.sh`,
`gates_fast.sh`, the fast suite) run detached (`setsid nohup`) because a 2 h tool limit kills
them; `YO_TEST_LEAK_VERDICT=0` as CI; format with the TREE's built `yo fmt` (#1092 changed the
layout); after any rebase onto a develop that moved `src/`, re-run build, checks and the fixpoint
before merging. Known local-only failures on the Linux WSL box: fast suite `temp_dir` and the
Tokyo `TZ` test; cli goldens `doc-*` (fixed by #1126) and `compile-allocator-fixed-oom-shapes`.

### 3.2 Phase 6 steps 3–4 and Phase 4.2 (the FTT-stub backstop)

**Step 3 landed (#1124, 2026-10-03).** Census first, then what landed and
what it found.

**Census (step 1 of this section).** `YO_DEBUG_SWALLOW=1` now prints a `[kept] site=… code=…
owner=…` line after each swallowed error that is not re-raised, and codegen prints
`[ftt-stub] kind=… site=… spec=… recorded=…` for each abort stub it writes
(`.github/instructions/debugging.instructions.md`). `scripts/soundness/swallow-census.sh` pairs
each `[kept]` line with the error it keeps. Measured with the branch's binary (develop
`aa772c3c9` plus this branch):

| target | swallowed | kept | `dg` | `dgc` | `anon-abstract` | `anon-ct` | other sites |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `check ./std` | 245 | 243 | 214 | 10 | 18 | 1 | 0 |
| `check ./src` | 157 | 155 | 135 | 10 | 9 | 1 | 0 |
| `check` of the fast suite's 311 kept batches, test-owned definitions only | — | 53 | 38 | 6 | 9 | 0 | 0 |

`fn-fwd`, `reeval-*` and `mat-default` kept nothing anywhere. Every swallow in `check ./src` is
owned by a `std` module that `src/` imports: `src/`'s own definitions keep none. The batch
row counts only definitions written in the tests; each batch re-checks std, which adds about
110 std swallows per batch.

The kinds, over `./std` (`./src`'s are the same kinds over fewer std modules):

| kind | count | site | example owner |
| --- | --- | --- | --- |
| a mismatch involving a type variable (E0601, unify) | 57 | dg 55, anon-abstract 2 | `std/prelude.yo:5432:53` |
| a CTFE call with an abstract argument (`Failed to call the function for compile-time`) | 51 | dg 37, anon-abstract 14 | `std/prelude.yo:7402:4` |
| a degraded `unit` operand fails a pattern, parameter or result | 34 | dg 34 | `std/prelude.yo:4850:4` |
| an `&&`/`||`/condition operand is a degraded `unit` | 27 | dg 27 | `std/prelude.yo:4726:4` |
| a type variable called as a constructor (`T(1)`) | 27 | dg 27 | `std/prelude.yo:4813:55` |
| a `comptime` parameter fed an abstract value | 22 | dg 22 | `std/prelude.yo:8288:91` |
| a trait default closure calls a method on an abstract `Self` (E0610) | 10 | dgc 10 | `std/prelude.yo:808:19` |
| a `cond` selecting a compile-time value on an abstract condition | 5 | dg 5 | `std/prelude.yo:8259:134` |
| no matching call for abstract arguments (E0610) | 3 | dg 3 | `std/prelude.yo:5370:46` |
| other: a `ref`-argument aliasing check, an inline-`asm` operand, and an expression argument, each of abstract type | 3 | dg 2, anon-ct 1 | `std/prelude.yo:7114:102` |
| `self.read` on the enum `_Transport` not found in a trait default's `io.async` closure (E0402) | 2 | anon-abstract 2 | `std/io/index.yo:74:22` |
| an abstract argument not yet known to implement `Future` (E0602) | 2 | dg 2 | `std/io/bufio.yo:255:6` |

Every `dg`/`dgc` keep is, by construction, an error in a body whose type variables are
abstract that is not `generic_independent`. The kinds say why it waits. An operator on an
unconstrained binder degrades to `unit`, and the `&&`, pattern and parameter rows are what
that unit then fails. A binder used as a value or a constructor (`T(1)`) waits too. So do CTFE
and comptime parameters fed an abstract value, and a trait default on an abstract `Self`.
The 53 test-owned keeps are the same kinds: 46 in the batches' own source, 6 in
derive-generated bodies of generic types, 1 in a fixture module. Nine sit inside a
`comptime_expect_error` argument (the invalid code the test expects to be rejected). The
others wait on a type variable, for example a `comptime_assert(Type.impls(T, Runtime))` or a
`comptime_expect_error(self.value == other)` in a generic body, which fires only once `T` is
known. The batch row was taken with an intermediate build of the branch (before the `unit`
operator fix; the `./std` and `./src` rows are the final build's, and match the intermediate
one exactly). The six batches whose `check` fails (E0906 ×4, StrictBorrow ×1, a verify batch)
fail identically on develop (§3.3 #8).

FTT stubs, from the develop baseline's fast suite with `YO_KEEP_BATCH=1` (4916 passed, 2
failed: the two known machine failures). There are 311 batch `.c` files and 64 stub
definitions in 31 of them:

| kind | count | what they are |
| --- | --- | --- |
| superseded generic original | 50 | dead by construction: every call dispatches a specialization |
| live, value-returning | 14 | all 14 are bodies of definitions written inside a `comptime_expect_error(...)` argument, the invalid code the test expects to be rejected; never called |
| specialization a call requested | 0 | — |

**Landed (step 3):**

1. **Instantiation notes.** A specialization whose body fails for the concrete types a call
   supplied reports the body's error with a note at each call that instantiated it:
   ``note: in `f` with T = i32, instantiated here``, chained through generic callers
   (`create_specialization_at_call`, `calls/helper.yo`). A std callee gets no note, because
   `evaluate_function_call` already re-anchors a std error at the user's call. A flagged flow
   violation gets the note too. Gate: `tests/cli-cases/a-failing-specialization-names-the-instantiating-call`
   (red on develop).
2. **The recorded-error backstop.** The generic fn and closure trials keep their swallowed
   error against the body (`record_generic_trial_error`, `expr_info.yo`). Each specialization
   records the call that first requested it (`record_spec_instantiation`). When codegen finds
   a specialization a call requested hollow, of a body with a recorded error, it reports that
   error with a note at the call instead of writing an abort stub. It fires on nothing in the
   corpus above (0 specialization stubs). It is the backstop the plan asks for, not a fix
   for a measured case.

**Step 3 found two bugs, both fixed at their cause:**

- `issues/fixed/a-generic-calling-a-generic-is-rejected-against-its-own-result-binder.md` (S2):
  a never-called valid generic was rejected with `Expected: U / Given: U`. The bridge that
  gives an opaque `Impl(...)` result its hidden type also stamped the caller's own rigid
  binder with the callee body's def-time type (`unit`, from the degraded operator).
- `issues/fixed/an-operator-unit-does-not-implement-passes-check.md` (S2): `() + ()`, or
  `twice(())` for `twice :: fn(generic(T), x : T) -> T (x + x)`, passed `check` and aborted at
  run time. This was the one live specialization stub found while probing. The operator
  rule's `unit` exemption, which exists for a generic trial's degraded placeholder, now
  applies only where a placeholder can exist (`SpecializingFunctionInfo.is_concrete`).

**What remains:**

1. **Step 4 / 4.2: a non-superseded stub is a compile error.** All 14 live stubs in the corpus
   are definitions inside `comptime_expect_error` arguments. Step 4 needs those either not
   emitted, or emitted as superseded, first. Otherwise every test that expects a rejected
   definition fails to compile. After that the measured class is empty.
2. **The kept kinds themselves.** By the classification above, none is a real error in
   `std`/`src`: each waits on a type variable or an abstract comptime value. Several kinds are
   degrades rather than deferrals, which is
   `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`: an operator on an
   unconstrained binder types as `unit`. That is the likely source of the `&&`/condition and
   degraded-`unit` rows (not measured). Typing such an operator as an unknown of an abstract
   result is the next lever on the census.
3. As before, the trial treats distinct binders leniently
   (`issues/fixed/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`).
   A body that unifies `T` with `S` records nothing, and the concrete specialization reports
   it, now with the instantiation note.

### 3.3 Phase 6 remaining sites

- **#8 test bodies.** Census 2026-09-29 over the 293 files of `tests/**/*.test.yo`. The two
  mechanical causes are fixed (#1062). The rest:
  - `check` gives each module its own ExprInfo table, so the D1 reach walk (E0906, 4 files)
    and StrictBorrow's mutation masks (1 file) see other modules' bodies as unevaluated. Fixed on
    `fix/check-foreign-bodies`: `issues/fixed/check-cannot-see-function-bodies-from-other-modules.md`
    (all five files pass `check --test-bodies`).
  - plain `check` of `closure_param_forwarding.test.yo` peaks at a 48 GB footprint, and the
    `imm_*` files die with SIGBUS. Not yet compared against develop.

  Make strict the default once the list is empty.
- **`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`.** A failed sub-evaluation
  in a generic trial is typed `unit`, so `mark_generic_independent` must not count `unit` as
  evidence. Two degrading cases are documented: `Array(u8, T.BYTES).fill(…)` and a method from
  a later impl of the same type. Removing the exclusion, and binding array lengths
  symbolically, were both tried on the stack and reverted: the first failed `check ./std`, the
  second broke `tests/array.test.yo`.
  Narrowed 2026-10-01: the `Array` case needs a design change, not a binding. A
  value-dependent length is the string `length_var = "T.BYTES"`, resolved BY NAME, so it is
  captured by any other binder called `T` (that is why the symbolic binding broke
  `tests/array.test.yo`). A length variable has to refer to its type variable by identity.
  The later-impl case is fixed on `fix/enum-final-name` (§3.4).
- **`wrap(wrap(x))` (fixed on `tss/option-of-generic-option-identity`).** Substitution keeps an
  instance's definition-era id, so `Option(Option(i32))` built by a generic fn applied to its own
  result nests two `Option` instances under one id. Four guards keyed by the id alone read that
  as a cycle: `type_key`'s path, `stable_type_identity`'s path, the intern token and step 4b's
  marker re-derivation guard. Each now keys a generic enum instance by its id plus its type
  arguments (`_tk_node_id`, `enum_instance_node_id`), as the Struct arm already did for the
  stream combinators. The self-compile C is a pure renaming (74 types), with no merge or split.
  `issues/fixed/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.md`,
  `issues/fixed/a-nested-generic-enum-instance-reads-as-comptime-only.md`. Any other guard
  keyed by a nominal id alone (the step-8 `g_trait_check_recursion_guard`, the struct arm of
  `stable_type_identity`) has the same shape. No reproducer was found for those.
- **Phase 3 step 9 (array lengths by identity)** has a written design in the plan (the
  `ArrayLen` sum, the site table, a five-step migration). Not started.
- **`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`**
  (S3, handed over by a peer 2026-10-01): `EnumT` has no `type_arguments`, so a phantom enum
  instance cannot be matched to its generic impl through a `comptime(K) : Type` parameter. The
  fix (a `type_arguments` field that `substitute` rewrites, plus the CTFE canonicalization
  memo) is type identity: gate it on byte identity.
- **`issues/fixed/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`** (fixed on `tss/generic-extern-trial`):
  the prelude's `GcTracer.visit` failed its definition-time trial on every `check` (a nested
  `*(U)` lost its SomeT-to-SomeT binding in `_resolve_some_types_deep`). It no longer blocks
  §3.2 steps 3–4. Do not expect step 3 to catch a body that mixes two distinct binders
  (`*T` passed where the callee's one `U` already took `*S`). The trial treats unresolved
  binders leniently, so no error is recorded, and the concrete specialization reports the
  mismatch (the issue doc's "What the trial does not catch").
- **`issues/fixed/a-generic-fn-with-a-nested-binder-fails-its-generic-callers-trial.md`**
  (found in review, fixed on `tss/generic-extern-trial`): the same false trial error on
  the Yo-fn route. `_funcval_bind_foralls`'s structural fallback did not bind `U` from
  `a : *U` given the caller's rigid `*T`, so a `-> *U` or `-> Pair(*U, *U)` callee failed
  its caller's trial with a swallowed E0613. Without the fix this blocks step 3 for user code.

### 3.4 Impl ordering

On `tss/enum-final-name`, tests in `tests/lazy_toplevel_bindings.test.yo` (+ fixture
`tests/fixtures/lazy_impl_later_member.yo`); each was red before. The issue docs move to `fixed/`
on that branch:

- `a-member-cannot-call-a-trait-method-from-a-later-impl-of-its-type`: the forcing guard is
  name-aware. A miss on a member the in-flight impl declares still belongs to that impl. Any
  other named miss forces the pending impls that DECLARE the name, and only those.
- `mutual-recursion-between-a-fn-and-a-trait-impl-body`: not the cycle. An element of
  `ArrayList(Self)` resolves to the declaration's nameless final, so the operator miss forced
  nothing. Impl forcing now names such a type by its binding (`type_binding_name`).
- `a-named-impl-miss-forces-the-importers-impls-mid-import` (new): the branch's own `check ./std`
  regression (§3.0).
- `a-lazy-impl-force-reaches-an-importer-parked-on-the-import` (new, present on develop and
  v0.2.47): a forcing pass searched every active walk, but every walk below the innermost is
  parked on the running import. A free function in an imported module that called a later
  impl's trait default forced the importer's impl of that type: E0906 on a valid program. Now
  an outer walk is searched only when it declares the type (the import-cycle case).

### 3.5 Other issues the plan links

- `emitted-c-identifiers-collide-with-header-macros`: fixed on `fix/header-macro-prefix`
  (`issues/fixed/emitted-c-identifiers-collide-with-header-macros.md`). Every Yo-derived local,
  parameter, field and enum payload member is emitted as `__yo_v_<name>`; compiler shapes
  (`_…`, `fn_yo_id_…`, `yo_id_…`, `closure_yo_id_…`, `var_…`, numeric literals) keep their
  spelling, so the rule is idempotent. ABI names and type/static fragments go through
  `c_symbol_name` (no prefix), adopted-struct fields through `c_field_name`, union members through
  `c_variant_member_name`. The rule for codegen authors is in
  `.github/instructions/c-codegen.instructions.md`. A narrower deny-list rule was rejected: the
  macro set of a `c_include`d header is not knowable at emit time.
- Closed in this stretch: `derived-eq-ref-enum-self-payload-hollow-at-runtime`,
  `a-stream-combinator-used-twice-in-one-chain-emits-two-c-types`,
  `yo-self-where-clause-full-enforcement`; retired (no longer reproduce):
  `anonymous-module-trial-swallows-a-top-level-derive`,
  `unused-variable-warning-for-a-forward-declared-comptime-fn-used-only-in-a-body`.

## 4. How to gate (read before merging anything)

The user's rule: admin-merge once the local gates pass, never while a release is being cut
(coordinate with peer sessions: `ListAgents`, `SendMessage`). The battery, from the worktree,
after `yo build --std-path ./std`:

```bash
B=$PWD/yo-out/aarch64-apple-darwin/bin/yo
$B check ./std --std-path ./std
$B check ./src --std-path ./std
YO_SELF_BIN=$B bash scripts/cli-diff-test.sh
$B test tests/internal/diagnostics_registry_examples.test.yo --std-path ./std --parallel 1
$B test tests/internal/error.test.yo --std-path ./std --parallel 1
YO_STD=$PWD/std $B test ./tests --exclude tests/internal --exclude tests/cli-cases --std-path ./std
cp $B ~/Workspace/Yo-wt/bins/yo-<name>
S1=~/Workspace/Yo-wt/bins/yo-<name> P=<name> bash scripts/bootstrap/fixpoint_only.sh
S1=~/Workspace/Yo-wt/bins/yo-<name> P=<name> bash scripts/bootstrap/gates_fast.sh
$B test tests/internal/module_invalidation.test.yo --std-path ./std --parallel 1
```

Plus the `tests/internal` files that construct or import what the change touched (grep for the
changed names). Lessons from this stretch:

- The fast suite **stops at the first batch that fails to compile**: a red fast leg must be
  re-run after the fix, not read as "one failure".
- A newly enabled definition-time trial must not stamp the real body's nodes: codegen reads
  some of those stamps (`io.async` closures). Diagnostic-only trials use
  `clone_expr_fresh_ids`.
- Re-raising a formerly swallowed error surfaces the bugs the swallow hid (three this stretch:
  the default-materialization scope, its raw evaluation, the unit degrade). Each is fixed at its
  cause, not re-swallowed.
- `pkill -f` takes an ERE: `"a\|b"` matches a literal `|`. Kill batteries by one pattern per
  call, then confirm with `ps`.
- `yo check <file>` on each edited file catches syntax and import-cycle slips in seconds
  (`x := a || b` needs outer parentheses; importing `types/function.yo` or `exprs/begin.yo`
  from `values/impl.yo` is a cycle — add a context.yo hook instead).
