# Type-system soundness: handover

**Status:** ACTIVE handover, written 2026-09-26 by the session that drove
[`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md) through Phases 2–5 and most of Phase 3.
The plan is the roadmap and stays authoritative for *what* each phase means. This doc says *where
the work stands*: what landed, what is written but unverified on four pushed branches, and what
nobody has started. Read the plan's Phase 3, 4 and 6 sections first, then this.

Move this doc to `archive/` with a banner once every branch below is merged or abandoned.

## 1. Where the plan stands

| Phase | State |
| --- | --- |
| 0 ratchet, 1 missing comparisons, 2 traits and generics | Landed (see the plan's "Landed" notes). |
| 3 type identity | Steps 1–6 landed. Step 7 part 1 landed (#940). Step 7 part 2 is on a branch (§3.2). Step 8 is in progress: three of the four double-emission issues are fixed (#938, #939, #941 on the way); the fourth has a minimal repro and no fix (§3.4). |
| 4 diagnostics | 4.1, 4.3, 4.4, 4.5 landed. **4.2 not started** (§4.1). |
| 5 ownership | Items 1, 2, 5, 6 landed here; 3 and 4 were handed to `archive/PARALLELISM_SOUNDNESS.md`, which closed them (#899, #902). |
| 6 retire the swallow policy | Step 1 (census) done, recorded in §5. Step 2 started on a branch for one site (§3.3). Steps 3–4 not started. |
| 7 docs | The 2026-09-25 list is done except the two items the plan names as owned by 5.2 and PARALLELISM (both since landed; re-read those two docs and close the items). |

Merged by this session in the last stretch (read the PR bodies for mechanisms and gates):

- **#938** identity is not invariant flow (`Option(Dyn).is_none()` emits).
- **#939** a type binding records the binder it resolves (`VariableRare.bound_some_id`).
- **#940** 3.7 part 1: a SomeT's resolution is an immutable `Option(Self)`.
- **#941** an extern opaque type is the nominal `ExternOpaqueT(name, c_name)`.
- **#942** develop red after #939/#940: `io.await` of a string-literal task; the `type_key`
  internal test.

## 2. How to gate (read before merging anything)

The user's rule is "admin-merge once the local gates pass". The local gates must cover what CI's
required checks cover, or develop goes red (it did, twice, this cycle: #939 and #940). The
battery used for every PR here, run from the worktree after `yo build --std-path ./std`:

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
S1=~/Workspace/Yo-wt/bins/yo-<name> P=<name> bash scripts/bootstrap/gates_fast.sh   # GATE 2 = tests/codegen-bootstrap corpus
$B test tests/internal/module_invalidation.test.yo --std-path ./std --parallel 1
# Phase 5 accepted variants under libgmalloc (ASan does not instrument on the Mac):
YO_KEEP_BATCH=1 $B test tests/type_soundness.test.yo --std-path ./std --parallel 1   # then run each
#   tests/.yo_selftest_batch_*.bin with YO_TEST_INDEX=i DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib
```

Plus: any change to a type that `tests/internal/*.test.yo` constructs or pattern-matches (a
`TypeValue` variant, a `SomeT` field, `SynthesizeOptions`) needs `grep -rn <name> tests/internal`
and the matching internal file run by hand. #940 broke `tests/internal/type_key.test.yo` that way
and nothing in the list above compiles that directory.

One build or battery at a time: the machine has 16 GB, and a peer session may be running its own.
Never edit a tree while its own build or gates run.

## 3. The four pushed branches

All four are pushed, based on develop `36ec17b8c` (after #942), and **none has been built yet**:
they were written while a peer's release battery held the machine. Develop has since gained #943
(`Option` of a reference handle is one pointer, which touches codegen's nullable-pointer paths and
`std`'s `String` layout): rebase each branch onto develop before building it. Each commit is small and
single-purpose so a failure can be bisected or a commit dropped.

### 3.1 `tss/flow-orientation`: the flow relation called backwards

Issue: `issues/the-flow-relation-is-called-with-its-arguments-reversed.md` (open; its repro is in
`issues/repros/`).

**The bug.** `are_types_compatible(actual, expected)` is directional, but thirteen checks call it
as (expected, actual). Measured on develop: a `Dyn(A)` built from a type that does not implement
`Bt` passes `check` as the argument for a `Dyn(A, Bt)` parameter, and at run time `x.b()`
dispatches through a vtable slot that does not exist; reassigning it into a `Dyn(A, Bt)` variable
silently retypes the variable to `dyn(A)`. An `atomic_ullong` is accepted for a `u64` parameter.
The same inversion is why flow *appeared* to have no `Dyn` upcast: the relation's `Dyn` rule is a
subset rule (an upcast), contradicting Phase 2.7's recorded decision, and the reversed call sites
turned it into a downcast check.

**What the branch does.**
- Flips the thirteen sites to (actual, expected): `helper.yo` argument check (Step 8, plus the
  debug line), `helper.yo` explicit-`using` and implicit-param checks, two argument checks in
  `calls/function.yo`, a parameter default (`types/function.yo`), a trait field's value and default
  (`types/trait.yo`), property assignment and reassignment (`exprs/assignment.yo`), the typed
  binding (`exprs/initialization_assignment.yo`), `as` (`builtins/as.yo`) and the Fn-trait check
  (`trait_checking.yo`). The other ~68 call sites were classified as correctly oriented or
  symmetric (joins, cross-case merges, value equality); the classification is in the commit.
- Makes `Dyn` flow the exact trait set in every mode (`compatibility.yo`, the DynT arm), per
  Phase 2.7.
- Updates `plans/reference/TYPE_IDENTITY.md` (flow is directional; no `Dyn` upcast or downcast).
- Adds canaries in `tests/type_soundness.test.yo`: the extern-into-scalar call, the `Dyn` downcast
  by call and by reassignment, the upcast (still rejected, with the "Yo does not upcast Dyn"
  note), and the relation in both directions.
- Separately: closes `order-dependent-generic-slot-stranding-e0605` (moved to `fixed/`). #939's
  recorded binder ids made the marker-and-frame-level checks that stranded the slot unnecessary;
  the gate is a deterministic unit test in `tests/internal/env_lookup.test.yo`, because the
  original repro depends on id luck.

**Expect** the flips to reject code that passes today. Every new rejection in the fast suite is
either a real bug in that test (fix the test, file it if it is the compiler's) or a site the
classification got wrong (then the canary for that rule tells you which direction is right).
Run the whole battery; `check ./std` and `check ./src` matter most, since std and the compiler are
the largest bodies of code that has only ever been checked by the reversed relation. The seed
(v0.2.43, the previous release) must still compile std and src after the change, which it will
because the seed does not contain the change; but anything std/src needs to change to pass the
*new* checks must be written so the seed also accepts it.

Then move the issue to `fixed/` with a Resolution section, regenerate `issues/TRIAGE.md`
(`python3 scripts/gen-issue-triage.py`), and note it in the plan's Phase 3 step 8 list.

### 3.2 `tss/p37-registry`: Phase 3 step 7 part 2 (retire `g_some_resolved_concrete`)

The global `g_some_resolved_concrete : HashMap(String, TypeValue)` (`src/expr_info.yo`) maps a
SomeT id to a resolution. Ids are shared by every copy and specialization of a declaration, so
every writer is a last-write-wins hazard; the plan's step 7 wants every resolution to travel on
the value (`SomeT.resolution`, immutable since #940, built with `t_with_resolution`).

**Done on the branch (unbuilt):**
1. **Step A: one reader accessor.** `some_resolution(t)` in `src/expr_info.yo` returns the value's
   own resolution, else the registry entry. Every reader that already read the value first (and
   several codegen readers that read only the registry) now goes through it: `codegen/async/*`,
   `codegen/exprs/{await,async,return,closures}.yo`, `codegen/types/generation.yo`,
   `codegen/utils/index.yo`, `codegen/functions/declarations.yo`, `pattern.yo`,
   `evaluator/utils/closure.yo`, `exprs/assignment.yo`, `types/synthesizer.yo`,
   `calls/{function,helper,function_type}.yo`, `values/impl.yo`, `types/function.yo`. When the
   last writer is gone, deleting the registry is a one-function change here.
2. **io.async output.** `_with_future_output_resolution` (`calls/function.yo`) gives the future's
   output SomeT the closure's concrete result as its resolution, instead of registering it under
   the output id; `io.await` reads it off the value. The output is already fresh per call
   (`_freshen_io_builtin_callee`), so this is per call by construction.
3. **Closure values.** `closure_type.yo` types a closure as its `Impl(Fn)` wrapper resolved to
   *this* closure's capture struct (`t_with_resolution`), instead of registering the capture under
   the wrapper id that every closure checked against the same annotation shares.
4. **The async emitter's per-block memo** (`<output id>@@<block id>` keys) moved to its own map,
   `g_async_block_result_types` in `codegen/exprs/async.yo`. It only borrowed the registry.
5. **Capbind.** The per-specialization rebuild of a closure parameter already carried its capture;
   the duplicate entry under its fresh id is removed.
6. Three removals marked **(experiment)** in their commit titles, each gated by a named test:
   - the struct-field capture write in `calls/type.yo` (gate: `tests/impl_fn_field_rejection`,
     "workaround B": `GenericCb(Impl(Fn(...)))(cb : x => ...)`); it may still be needed, because a
     struct instantiated over an `Impl(Fn)` wrapper has one field SomeT for every instance. If it
     is, the right fix is to instantiate the struct over the closure identity, the way #930 did for
     containers, not to restore the write;
   - the opaque-return write in `calls/function_type.yo` (the fn type already carries the hidden
     type since #940; the write covered call sites evaluated before the body, i.e. recursion and
     forward references; gate: the async and opaque-return tests);
   - the shared declared-id capbind write in `calls/helper.yo` (its comment said it served
     "consumers that resolve the DECLARED param type rather than the bound variable's"; if a test
     fails, find that consumer and make it read the bound variable's type).
7. A doc-comment placement mistake from #939 (`_adopt_deep_resolution` between
   `_freshen_io_builtin_callee` and its comment) is fixed.

**Not done:** two writers in `calls/helper.yo` and the registry itself.
- **Forwarded Future-wrapper parameters** (`register_some_resolved_concrete(fw_id, fw_arg)`,
  "FUTURE-wrapper param"): make it a per-specialization rebuild of the declared wrapper carrying the
  argument's wrapper as its resolution, bound as the parameter's type, exactly like the capbind
  rebuild a few lines below it. Gate: `tests/async_await.test.yo` arm 72
  (`test_unwind(task, io)`).
- **The Fn-bound result binder** (`register_some_resolved_concrete(fn_res_id, cl_res3)`): the
  declared bound's result is the enclosing function's own generic (`cb : Impl(Fn(io : Io) -> T)`).
  This is a *type binding of `T`* in the specialization's env, and since #939 a binding can record
  the binder it resolves (`variable_set_bound_some_id`, as the Step-6b pre-bindings do through
  `_record_prebound_binder`). Do that instead of the global. Gate:
  `issues/fixed/generic-channel-send-specialisation-is-called-but-never-emitted.md`'s test.
- **`unregister_some_resolved_concrete`** (the Step-6 marker loop in `helper.yo`) disappears with
  the last writer.
- Then delete `g_some_resolved_concrete`, `register/lookup/unregister_some_resolved_concrete`, the
  compat hook (`set_compat_lookup_some_resolved_fn`, `compatibility.yo`) and the guards hook
  (`set_lookup_some_resolved_concrete`, installed in `codegen_c.yo`'s `compile_module`), and make
  `some_resolution` read only the value. Remaining id-only readers at that point are bugs: each
  must be handed the SomeT value.
- The `E` skip in `_resolve_some_types_deep` ("the global table is poisoned by prior IoExn
  registrations") exists only because of the registry; re-test without it once the registry is
  gone.

The census this was planned from (every writer and reader, where it runs, and why) is reproduced
in §6. Measure after each writer: `tests/async_await.test.yo`, `tests/closure*.test.yo`,
`tests/thread.test.yo`, `tests/algebraic_effects.test.yo`, then the battery. This is a
byte-identity event only if a C type's key changes; the fixpoint will say.

### 3.3 `tss/p6-closure-reraise`: Phase 6 step 2 for closure bodies

Issue: `issues/closure-body-type-errors-are-swallowed-into-a-runtime-abort.md` (census site #5).

**What the branch does.** `_trial_eval_anon_body`'s callers (`values/anonymous_function.yo`)
re-raise a swallowed error when the closure's parameters are all concrete
(`body_params_concrete`, read *before* the io.async and ctl-handler forcing, which evaluates
SomeT-parameter bodies too) and the body produced nothing. The anonymous swallow channel now keeps
the structured diagnostics in lockstep with the text (`g_anon_swallow_diags`, the twin of
`g_trial_swallow_diags`), so the re-raise carries the code and span. Two check-level CLI cases
are added (`tests/cli-cases/check-closure-body-type-error-is-reported`,
`check-ctl-handler-return-type-error-is-reported`); their goldens are **not recorded yet**: build,
run `YO_SELF_BIN=$B bash scripts/cli-diff-test.sh --record <case>` for each, and check the
recorded stdout names E0601 at the closure. A `comptime_expect_error` test cannot pin this class,
which is why they are CLI cases.

It also adds a `YO_DEBUG_SWALLOW` trace (`[reeval-swallow]`) to `_reeval_closure_body_swallow`
(census site #15) so the fast suite can be censused for that site before deciding whether it can
re-raise.

**Expect** false positives to show up as new check failures in std, src or the fast suite. Each
one is either a real latent error (the whole point) or a closure whose parameter looked concrete
but whose body still depends on something only a call resolves; read `[anon-swallow]` output
(`YO_DEBUG_SWALLOW=1`) for the failing file before changing the gate.

When it passes: move the issue to `fixed/`, and check whether
`issues/anonymous-module-trial-swallows-a-top-level-derive.md` flips too (the census found its
trace is an `[anon-swallow]`, i.e. this site, not the module trial its title blames).

### 3.4 `tss/option-self-field`: a minimal repro, no fix

Issue: `issues/option-self-field-on-environment-splits-into-two-c-types.md` (Phase 3 step 8's last
double-emission issue). The branch adds the first minimal repro
(`issues/repros/option-self-field-on-environment-splits-into-two-c-types.yo`) and rewrites the
issue's repro section:

```rust
Env :: ref(struct(n : i64, memo : Option(Self)));
first :: (fn(l : ArrayList(Env)) -> Option(Env))(l.get(usize(0)));
```

The `ArrayList(Env).get` specialization is emitted returning the abstract `Option(T)` (its C struct
comment says so) while `first` declares `Option(<Env>)`. Without the `Option(Self)` field it
works; `l.get` called directly in `main` works; the call from a function whose *signature* names
`ArrayList(Env)` fails, in one module or two; v0.2.43 fails the same way. Next step: trace why that
specialization's result is not substituted. Suspects, in order: the CTFE memo matching
`Option(<Env self-shell>)` against the abstract `Option(T)` entry (`Env`'s shell still contains the
`Self` SomeT while its field `Option(Self)` is built, so `_has_abstract_some` may be true on both
sides; compare `issues/fixed/an-extern-opaque-type-unifies-with-every-dyn.md`, the same memo hole
for `Dyn`), then `_patch_self_shell` (`types/creators.yo`) not reaching an instantiation minted
while the signature was evaluated. This branch can merge on its own (docs only).

## 4. Not started

### 4.1 Phase 4.2: a reachable FTT stub is a compile error

Today only a `// Failed to transpile` marker in `__yo_user_main` is fatal
(`codegen/functions/generation.yo`, "ENTRY-POINT GATE"); every other stub body is rewritten to
`abort()`. The code comment there records 34 rewritten stubs in the fast-suite corpus and the
earlier attempt to make them fatal, reverted because `tests/fn.test.yo` and
`tests/algebraic_effects.test.yo` carry dead superseded-generic stubs. So 4.2 needs a reachability
notion (live = reachable from an exported entry point through emitted calls, excluding
`fid_fully_specialized` superseded generics), and it is best landed as Phase 6's backstop, after
the stubs are gone, as the plan's step 6.4 says. Measure the live stub count on the fast suite
first; that number is Phase 6's progress metric.

### 4.2 Phase 6 steps 2–4 for the other sites

From the census (§5): sites #2/#6 (the deferred-generic trials in `calls/function_type.yo` and
`values/anonymous_function.yo`) need a finer test than "the body has SomeTs", namely "the error
does not involve one", and they currently *clear* flow violations raised inside the trial;
`issues/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md` goes through them. Site #4
(the forward-comptime-fn re-run) drops the error on its last attempt. Site #8 (test bodies) is
strict only under `--test-bodies`; making it the default needs a false-positive census first
(`yo check --test-bodies` over every `tests/**/*.test.yo`). Site #14
(`_materialize_default_body`) falls back silently when `Self` is concrete. Site #16
(`_evaluate_expression_wrapper`, every 3-argument `evaluate_expression`, ~123 call sites) turns any
sub-expression error into an error expression; it is the "per-node swallow" and the largest item.
Step 3 (record a SomeT-pending error against the specialization and re-raise it, with the call
site as a note, when the concrete specialization fails) has no code yet.

### 4.3 Other open issues the plan links

- `issues/derived-eq-ref-enum-self-payload-hollow-at-runtime.md`: the census could not attribute
  it to a listed site (its trace shows the concrete fn trial with no `[swallow]`); likely site #16.
- `issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md`: since Phase 1.6 it is a loud
  E0610, but the error itself is wrong. The root cause is impl-field forcing order
  (`_force_field_eval`, `values/impl.yo`), not a swallow.
- `issues/address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md`,
  `issues/emitted-c-identifiers-collide-with-header-macros.md`,
  `issues/unknown-type-argument-in-typed-binding-reports-expected-comptime.md`,
  `issues/yo-self-where-clause-full-enforcement.md`: untouched this session.

## 5. Phase 6 swallow census (2026-09-26, develop `36ec17b8c`)

Re-raise channels today: the flow-violation box (`types/flowability.yo`),
`propagate_def_time_errors` (only inside `comptime_expect_error`), and `hard_swallow_diagnostic`
(`evaluator/context.yo`: forward references, `auto-generated://`, argument-count mismatch, unbound
variable).

| # | Site | Trialled | Error | Class |
| --- | --- | --- | --- | --- |
| 1 | `calls/function_type.yo` `_trial_eval_fn_body`, concrete caller | named fn body | re-raised via `g_trial_swallow_msg`/diags when `!should_defer_ft` | right already |
| 2 | same, deferred-generic caller | generic body | dropped (hard diags only), flow violations cleared | needs "error involves a SomeT?" |
| 3 | same, V6 verify trial | deferred body | dropped | duplicate of #2 |
| 4 | same, pending re-run | fwd-comptime-fn body | dropped on the last attempt | illegitimate |
| 5 | `values/anonymous_function.yo` `_trial_eval_anon_body` | closure body | dropped unless hard/flow/propagate | illegitimate for concrete params: §3.3 |
| 6 | same, deferred generic closure | generic closure | as #2 | as #2 |
| 7 | `_trial_eval_annotation_type` | param annotation | inference probe | legitimate |
| 8 | `exprs/test.yo` `_trial_eval_test_body` | test body | dropped unless `--test-bodies` | illegitimate |
| 9 | `calls/helper.yo` `_trial_eval_ret_type_expr` | return-type expr | keeps def-era type | legitimate |
| 10 | `calls/function.yo` `_trial_call_overload_candidate` | overload candidate | candidate rejected | legitimate |
| 11 | `builtins/derive.yo` `_derive_eval_guarded` | derive rule/impl | re-raised | not a swallow |
| 12 | `values/anonymous_module.yo` `_run_module_walk` | module walk | re-raised | not a swallow |
| 13 | `_force_eval`, `_force_field_eval` | lazy defs, impl fields | re-raised at the miss | not a swallow |
| 14 | `values/impl.yo` `_materialize_default_body` | trait default per impl | falls back to the shared default | illegitimate when `Self` is concrete |
| 15 | `calls/helper.yo` `_reeval_closure_body_swallow` | closure body at specialization | dropped | illegitimate (types concrete); census trace on §3.3's branch |
| 16 | `exprs/_expr.yo` `_evaluate_expression_wrapper` | any sub-expression | error expression | illegitimate (the per-node swallow) |

Other local `Exception` probes (`calls/function.yo`, `calls/helper.yo`, `calls/index_trait.yo`,
`values/impl.yo`, `trait_checking.yo`, `types/trait.yo`, `ctfe/ctfe_analysis.yo`,
`exprs/begin.yo`) are documented best-effort inference/dispatch probes that fall back on failure:
legitimate control flow.

## 6. Registry census for §3.2 (writers and readers of `g_some_resolved_concrete`)

Writers on develop `36ec17b8c`, with their state on `tss/p37-registry`:

| Writer | What | Branch state |
| --- | --- | --- |
| `calls/function.yo` io.async (both call arms) | future output id → closure result | moved to the value |
| `calls/closure_type.yo` | closure wrapper id → capture struct | moved to the value |
| `calls/type.yo` | struct field SomeT id → capture struct | removed (experiment) |
| `calls/function_type.yo` | declared opaque return id → hidden type | removed (experiment) |
| `calls/helper.yo` capbind fresh id | fresh id → capture | removed (value already carried it) |
| `calls/helper.yo` capbind shared id | declared closure-param id → capture | removed (experiment) |
| `calls/helper.yo` Future-wrapper param | declared wrapper id → arg wrapper | **todo** |
| `calls/helper.yo` Fn-bound result | enclosing fn's result binder id → closure result | **todo** |
| `calls/helper.yo` Step-6 marker loop | unregister | goes with the last writer |
| `codegen/exprs/async.yo` (two) | `<output>@@<block>` → result type | moved to `g_async_block_result_types` |

Readers: 37 call sites in 19 files on develop; on the branch every one that had the SomeT value
goes through `some_resolution`, and the io.async readers that took only an id
(`values/impl.yo`'s `JoinHandle` binding, `types/function.yo`'s `_resolve_some_types_deep` and
`_resolve_type_arg_somes`) read the value too. The few remaining `lookup_some_resolved_concrete`
calls (`codegen/exprs/await.yo`'s ordered fallback, `helper.yo`'s capbind write-back gate) keep
the registry as a fallback and go when the registry does.

## 7. Lessons from this stretch (also in the session memory)

- The local battery must include `gates_fast.sh`: `tests/codegen-bootstrap/*.yo` compiles only
  there, and #939 went red on develop through it.
- A change to a `TypeValue` variant or `SomeT` field needs the `tests/internal` grep (§2).
- `comptime_expect_error` cannot pin an error a definition-time trial swallowed; use a check-level
  CLI case (`tests/cli-cases/`), `cmd` ending in a newline, fixture formatted before recording.
- `yo check <file>` on each edited file takes seconds and catches syntax slips before a 15-minute
  build: `.SomeT(_)` is not a valid variant pattern (use `.SomeT({ id : _ })`), and a
  one-expression `{ ... }` parses as a struct literal.
- `are_types_compatible` is `(actual, expected)`; `Type.is_compatible_with(A, B)` is "A flows into
  B"; the synthesizer is `(expected, given)` and two of its callers (Step 10 and the
  return-vs-expected helper) pass (source, destination), marked by
  `SynthesizeOptions.expected_is_source`.
- Coordinate with peer sessions before builds and merges (`ListAgents`, `SendMessage`); a release
  battery must not be superseded by a merge.
