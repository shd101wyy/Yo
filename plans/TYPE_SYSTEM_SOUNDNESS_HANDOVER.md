# Type-system soundness: handover

**Status:** updated 2026-09-28. The plan is [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md);
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

### 3.1 Stream combinator used twice in one chain

`issues/a-stream-combinator-used-twice-in-one-chain-emits-two-c-types.md`
(`ch.map(f).map(g)`, `filter(...).filter(...)`) fails in the C compiler on develop too. The
`map` specialization's C signature keeps SomeT type arguments while the value it builds is
keyed by concrete ones. Both calls of `map` share binder ids. Start by finding the site that
builds the specialization's declared result type.

### 3.2 Phase 6 steps 3–4 and Phase 4.2 (the FTT-stub backstop)

1. Measure: run the fast suite with `YO_KEEP_BATCH=1` and count, in the kept `.c` files, the
   stubs by kind (`abort(); /* superseded generic original`, `/* untranspilable body in a
   value-returning fn`, `/* untranspilable body in a unit fn`). The compiler's own
   self-compile has none (the four strings in `stage2.c` are the emitter's literals).
2. Step 3: when a body's trial swallowed an error that was pending on a type variable and the
   concrete specialization then produces an FTT stub, raise that recorded error at the stub
   (with the call site as a note) instead of emitting the stub.
3. Step 4 / 4.2: a non-superseded stub is a compile error. The linker oracle was tried and
   reverted (a stub whose address is stored in a live handler survives DCE); with step 3 in
   place such stubs are bugs to fix, not to tolerate.

### 3.3 Phase 6 remaining sites

- **#8 test bodies** are strict only under `--test-bodies`. Census `yo check --test-bodies`
  over every `tests/**/*.test.yo` before making it the default.
- **#16 residue** (7 sites): the two deliberate probes stay
  (`pattern_compile.yo` `_bind_subject_and_eval_test`, `index_trait.yo`
  `_try_comptime_custom_type_index`); `match.yo`'s scrutinee already retries raw; the silent
  no-ops in `var_fns.yo` (×3) and `comptime_assert.yo`'s validation-mode check need a decision
  (they are debug/rc-introspection builtins).
- `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`: find the fallback that types
  `Array(u8, T.BYTES).fill(u8(0))` as `unit` in a generic trial, then drop the `unit` exclusion
  in `mark_generic_independent`.

### 3.4 Other open issues the plan links

- `issues/derived-eq-ref-enum-self-payload-hollow-at-runtime.md` (likely site #16 residue or #14).
- `issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md` (impl-field forcing order).
- `issues/anonymous-module-trial-swallows-a-top-level-derive.md`.
- `issues/unused-variable-warning-for-a-forward-declared-comptime-fn-used-only-in-a-body.md`.
- `issues/emitted-c-identifiers-collide-with-header-macros.md` (a byte-identity event).
- `issues/yo-self-where-clause-full-enforcement.md` (re-measure the `String <: (Eq, Hash)`
  residual first; the addendum says method bounds are enforced).

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
