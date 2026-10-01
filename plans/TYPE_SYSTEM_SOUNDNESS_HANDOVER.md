# Type-system soundness: handover

**Status:** updated 2026-10-01. The plan is [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md);
it stays authoritative for what each phase means. This doc says where the work stands and what
to do next. Move it to `archive/` with a banner once §3 is empty.

## 1. Where the plan stands

| Phase | State |
| --- | --- |
| 0 ratchet, 1 missing comparisons | Landed. |
| 2 traits and generics | Landed, including 2.8 explicit Dyn upcast (#965). |
| 3 type identity | Landed, including step 7 part 2, the SomeT registry retirement (#975). |
| 4 diagnostics | 4.1, 4.3, 4.4, 4.5 landed. **4.2 open** (§3.2), best landed as Phase 6.4. |
| 5 ownership | Landed (3 and 4 via `archive/PARALLELISM_SOUNDNESS.md`). |
| 6 swallow policy | Steps 1–2 landed (#968, #1062). Open: site #8 (§3.3), steps 3–4 (§3.2). |
| 7 docs | Done; each phase updates its docs as it lands. |

## 2. Landed in this stretch (2026-09-29 → 2026-10-01)

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

### 3.1 The owning JoinHandle (step 2) and the state-machine leaks

`fix/sm-dup-temp-leak` (a dup-result temp released through an empty field; the task-abort
registry array never freed) with `fix/join-handle-owning` stacked on it (std's `JoinHandle` is
the `ref` struct again, now that `SEED_VERSION` is v0.2.47; the value branches of both
lowerings are deleted). Gate the tip once, then merge in order.

### 3.2 Phase 6 steps 3–4 and Phase 4.2 (the FTT-stub backstop)

Unchanged:
1. Measure stubs by kind in the fast suite's kept batches (`YO_KEEP_BATCH=1`).
2. Step 3: re-raise a SomeT-pending swallowed error when the concrete specialization produces
   a stub.
3. Step 4/4.2: a non-superseded stub is a compile error.

### 3.3 Phase 6 remaining sites

- **#8 test bodies.** Census 2026-09-29 over the 293 files of `tests/**/*.test.yo`. The two
  mechanical causes are fixed (#1062). Still open:
  - `check` gives each module its own ExprInfo table, so the D1 reach walk (E0906, 4 files)
    and StrictBorrow's mutation masks (1 file) see other modules' bodies as unevaluated:
    `issues/check-cannot-see-function-bodies-from-other-modules.md` (design in the doc).
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
- **`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`**
  (S3, handed over by a peer 2026-10-01): `EnumT` has no `type_arguments`, so a phantom enum
  instance cannot be matched to its generic impl through a `comptime(K) : Type` parameter. The
  fix (a `type_arguments` field that `substitute` rewrites, plus the CTFE canonicalization
  memo) is type identity: gate it on byte identity.
- **`issues/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`** (new):
  the prelude's `GcTracer.visit` fails its definition-time trial on every `check`, and the
  failure is swallowed. It blocks §3.2 steps 3–4, which would re-raise it.

### 3.4 Impl ordering

Both fixes are on `fix/enum-final-name`, with tests in `tests/lazy_toplevel_bindings.test.yo`;
each was red before. Gate the branch, then move both issue docs to `fixed/`:

- `issues/a-member-cannot-call-a-trait-method-from-a-later-impl-of-its-type.md`: the forcing
  guard is now name-aware. A miss on a member the in-flight impl declares still belongs to that
  impl; any other miss forces the type's later impls.
- `issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md`: not the cycle (measured
  table in the doc). An element of `ArrayList(Self)` resolves to the declaration's nameless
  final, so the operator miss forced nothing. Impl forcing now names such a type by its binding
  (`type_binding_name`). Enums and structs were both affected.

### 3.5 Other issues the plan links

- `emitted-c-identifiers-collide-with-header-macros`: open. A survey of every
  `sanitize_for_c_identifier` site is done. The rule has to be idempotent and skip
  compiler-generated shapes (`_…temp_…`, `__yo_*`, `fn_yo_id_`, `yo_id_`, `var_…`). Capture-struct
  fields are spelled raw at many sites and must move together with the declarations.
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
