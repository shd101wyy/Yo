# Type-system soundness: handover

**Status:** updated 2026-09-29. The plan is [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md);
it stays authoritative for what each phase means. This doc says where the work stands and what
to do next. Move it to `archive/` with a banner once §3 is empty.

## 1. Where the plan stands

| Phase | State |
| --- | --- |
| 0 ratchet, 1 missing comparisons | Landed. |
| 2 traits and generics | Landed, including **2.8 explicit Dyn upcast (#965)**. |
| 3 type identity | Landed, including **step 7 part 2 (the SomeT registry retirement)**. |
| 4 diagnostics | 4.1, 4.3, 4.4, 4.5 landed. **4.2 open** (§3.2), best landed as Phase 6.4. |
| 5 ownership | Landed (3 and 4 via `archive/PARALLELISM_SOUNDNESS.md`). |
| 6 swallow policy | Step 1 (census) and **step 2 landed (#968)** for sites #2, #4, #5, #6, #14, #15, #16. Open: site #8, step 3, step 4 (§3.2, §3.3). |
| 7 docs | Done; each phase updates its docs as it lands. |

## 2. Landed in this stretch

- **#965 — Phase 2.8.** `upcast(d, Dyn(...))` through per-target vtable pointers; one canonical
  `Dyn` trait order (by trait id); E0616 for two same-named slots in one `Dyn` and for an
  unqualified call two trait impls supply; `dyn(d)` of a `Dyn` names `upcast`; `&param` in a
  generic fn called with a literal. Issues closed: `dyn-trait-order-is-part-of-its-c-type`,
  `two-traits-sharing-a-method-name-in-one-dyn-emit-a-duplicate-c-wrapper`,
  `a-method-call-two-trait-impls-supply-silently-picks-one`,
  `dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c`,
  `address-of-a-parameter-in-a-generic-fn-emits-a-placeholder`.
- **Phase 3 step 7 part 2 — the SomeT registry retirement.** `g_some_resolved_concrete` is
  gone. Its first build broke compiled programs five ways, each fixed at its cause
  (`issues/fixed/p37-registry-retirement-blocked-by-codegen-readers.md`): a `Concrete(...)`
  wrapper's own resolution adopted by a name-keyed deep resolve (two `Park` C structs); a
  `(name, level)` substitution crossing binders that share a spelling (`map(f).filter(g)` →
  E0905); `stable_type_identity` spelling a SomeT by its binder (two closures' capture structs
  aliased); the Fn-result pre-binding typed as the result instead of `Type` (`map_values`); and
  a struct built with a closure in an `Impl(Fn)`-typed field, now instantiated over that closure
  identity instead of an id-keyed registry write. Its Linux CI also found a develop bug, fixed on the branch: a
  `ClosureType({...})` closure did not own its RC captures, so returning one read freed memory
  (`issues/fixed/a-closuretype-closure-does-not-own-its-rc-captures.md`).
- **#980 — a develop regression from #973.** An early `return(x)` of a hoisted state-machine
  local completed its future with NULL, which made the stage-2 compiler segfault in
  `yo install` on a cold cache
  (`issues/fixed/an-early-return-of-a-hoisted-state-machine-local-completes-with-null.md`).
- **#968 — Phase 6 step 2.** Replaces the closed #962 (its E1104 code classified a symptom; its
  last commit deleted E0607's `yo explain` entry). What landed, per census site:
  - #5 closures with concrete runtime parameters re-raise; a `comptime(x)` value parameter
    defers, as the named-fn path's `ft_has_ct_param` does;
  - #2/#6 every deferred generic fn and closure body is trialled (on a fresh-id clone when no
    result comparison needs its stamps), and an error whose primary diagnostic is
    `generic_independent` — a mismatch between two types with no type variable, no
    value-dependent array length and no `unit` stand-in — is re-raised; a comptime value
    parameter defers;
  - #15 the specialization-time closure re-eval re-raises generic-independent errors;
  - #14 a trait default that fails for a concrete `Self` is the impl's error — which surfaced
    two latent bugs, both fixed: the default was materialized in the implementing module's
    scope (`issues/fixed/a-trait-default-is-materialized-in-the-implementing-modules-scope.md`)
    and evaluated raw, so a bare `return(...)` default failed;
  - #4 the forward-comptime-fn re-run reports a body that still fails once its forward
    declarations are filled (`issues/fixed/a-forward-comptime-fn-body-error-is-dropped-by-the-pending-rerun.md`);
  - #16 116 of the 123 per-node swallow sites propagate the sub-expression's own error
    (`evaluate_expression_raw`, or `evaluate_expression_guarded` where ctx state is restored
    first). Fixed on the way: `issues/fixed/unknown-type-argument-in-typed-binding-reports-expected-comptime.md`,
    `issues/fixed/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`.

## 3. Open work, in order

State 2026-09-29. The branches form one stack on #975, `tss/p37-registry-v2` →
`tss/stream-repeat` → `tss/impl-order` → `tss/impl-self-operator`. The tip is built and gated
as one tree (§4); the PRs merge in order.

### 3.0 develop must build with the seed (blocks everything)

#991 made `JoinHandle` an owning `ref` struct, which the v0.2.45 seed cannot lower, so develop's
stage 1 failed from `c52ce152c` on. #996 (`fix/seed-safe-join-handle`) puts std back on the value
struct and lowers by the handle's type. It also carries #992 (read_dir). The flip back to the
owning handle waits for a release: `issues/join-handle-ownership-waits-for-the-seed.md`.

### 3.1 Stream combinator used twice in one chain

`issues/a-stream-combinator-used-twice-in-one-chain-emits-two-c-types.md`. On
`tss/stream-repeat`: the three id-keyed identity guards key on the type arguments too (type_key's
cycle guard, the spec cache, the intern key's struct token), plus the pre-where-pass bindings.
2-deep chains are fixed; the intern-key change for 3- and 4-deep chains still needs a build
(repros `tmp/v_m*.yo`, `tmp/v_fff.yo`, `tmp/v_mix.yo`, `tmp/it_mmm.yo` in `tss-eqrec`).

### 3.2 Phase 6 steps 3–4 and Phase 4.2 (the FTT-stub backstop)

Unchanged:
1. Measure stubs by kind in the fast suite's kept batches (`YO_KEEP_BATCH=1`).
2. Step 3: re-raise a SomeT-pending swallowed error when the concrete specialization produces
   a stub.
3. Step 4/4.2: a non-superseded stub is a compile error.

### 3.3 Phase 6 remaining sites

- **#8 test bodies.** Census 2026-09-29: `check --test-bodies` over the 293 files of
  `tests/**/*.test.yo` (not `internal/`, not `cli-cases/`). Failures by cause:
  - auto-boxed `dyn` built its `box(...)` call with node id 0 (9 files). Fixed on
    `tss/impl-self-operator`: `issues/fixed/an-auto-boxed-dyn-value-builds-its-box-call-with-node-id-zero.md`.
  - a comptime float converted to an integer kept its float text (1 file). Fixed on the same
    branch: `issues/fixed/a-comptime-float-converted-to-an-integer-keeps-its-float-text.md`.
  - `check` gives each module its own ExprInfo table, so the D1 reach walk (E0906, 4 files) and
    StrictBorrow's mutation masks (1 file) see other modules' bodies as unevaluated. Open, with
    the design: `issues/check-cannot-see-function-bodies-from-other-modules.md`.
  - plain `check` of `closure_param_forwarding.test.yo` peaks at a 48 GB footprint, and the
    `imm_*` files die with SIGBUS. Not yet compared against develop.

  Make strict the default once the list is empty.
- **#16 residue.** Done on `tss/impl-self-operator`:
  - `Var.is_owning_the_rc_value` and `Var.has_other_aliases` propagate their argument's error
    and reject a non-variable;
  - `comptime_assert`'s validation mode evaluates its condition without the swallow;
  - the no-op `Var.print_info` is removed.

  The two deliberate probes stay.
- `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`. On the same branch, unbuilt:
  a variable array length binds a const-generic length symbolically (`N := T.BYTES`), so
  `Array(u8, T.BYTES).fill(u8(0))` types as the array, and `unit` counts as evidence again in
  `mark_generic_independent`. Needs `check ./std` + `./src` for any other degradation the change
  surfaces.

### 3.4 Other issues the plan links

- `derived-eq-ref-enum-self-payload-hollow-at-runtime`: two bugs, both fixed on
  `tss/impl-self-operator` (unbuilt).
  - A `ref(enum)` no longer folds into a nullable pointer, which had emitted `typedef T* T`.
  - A concrete impl's trait-constructor members are pending inner fields, as Case 2's are: a
    recursive or forward operator call binds the member's FuncVal, and a signature-only in-flight
    hit forces the member.
- `mutual-recursion-between-a-fn-and-a-trait-impl-body`: `tss/impl-order` (the operator path
  forces pending impls) plus the inner fields above.
- Retired (no longer reproduce, guards added):
  - `anonymous-module-trial-swallows-a-top-level-derive`
  - `unused-variable-warning-for-a-forward-declared-comptime-fn-used-only-in-a-body`
- Closed: `yo-self-where-clause-full-enforcement`. Every bound class is enforced at the call
  site; regression tests are in `tests/where_clause_fn_inference.test.yo`.
- `emitted-c-identifiers-collide-with-header-macros`: open. A survey of every
  `sanitize_for_c_identifier` site is done. The rule has to be idempotent and skip
  compiler-generated shapes (`_…temp_…`, `__yo_*`, `fn_yo_id_`, `yo_id_`, `var_…`). Capture-struct
  fields are spelled raw at many sites and must move together with the declarations. Start after
  the stack lands (it touches the same codegen files).

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
