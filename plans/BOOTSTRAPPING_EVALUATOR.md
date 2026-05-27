# Bootstrapping the Evaluator — Self-Hosted `yo check`

> **Status: active plan.** Focused sub-goal of the broader bootstrap
> effort ([`BOOTSTRAPPING.md`](BOOTSTRAPPING.md)). This document narrows
> the target to the **evaluator** and the **`check` subcommand only** —
> deliberately excluding codegen — so the self-hosting milestone becomes
> tractable and measurable.

## Goal

Make the self-hosted compiler (`yo-self/`, built into `yo-self-bin`)
pass the **`check`** subcommand on three corpora, in order:

```bash
yo-self-bin check ./std
yo-self-bin check ./tests
yo-self-bin check ./yo-self
```

`check` runs **lexer → parser → evaluator** (type-check, CTFE, trait
resolution) and stops before codegen. So this goal isolates the
evaluator: when `yo-self-bin check ./yo-self` passes, the self-hosted
evaluator can validate its own source — a true evaluator-level
self-hosting fixpoint.

The work is a **faithful 1-to-1 port** of `src/` → `yo-self/` (see
[strict 1-to-1 rule](#strategy-strict-1-to-1-port)), continued and
repaired — not a rewrite. The evaluator is already ~95% ported
(134 `.yo` files / ~61k LoC vs 130 `.ts` / ~59k LoC, identical subdir
structure).

## Non-Goals

- **No codegen.** `check` never reaches codegen, so the async runtime,
  `generation.ts`, `other-fn-call.ts`, effect state machines, RC
  lowering, etc. are all **out of scope** for this plan. (They remain
  in [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md) for the full `compile`/`test`
  self-hosting goal.)
- **No `compile` / `test` self-hosting.** Those need codegen; tracked
  separately.
- **No new language features.** This is a port-and-repair effort; the
  language semantics are whatever `src/` currently implements.
- **No performance work** beyond what's needed to not crash (the stack
  overflow, below, is a correctness blocker, not an optimization).

## Why `check`-only is the right first milestone

- It exercises the largest, most-complete subsystem (the evaluator) end
  to end, on real, demanding input (std, the test corpus, and the
  compiler itself).
- It is a clean cut: no dependency on the unported/partial codegen
  subsystems that currently block `compile`/`test` self-hosting.
- `check ./yo-self` is a self-validation fixpoint — strong evidence the
  evaluator port is faithful.
- It is incrementally measurable: number of files in each corpus that
  `check` cleanly.

---

## Current state (measured 2026-05-27)

### Phase 0 progress (2026-05-27 session)

**Fixed (4 commits, ~45 files):**

- "Cannot reassign env/env_mut" errors: replaced param reassignments with
  field-level copies across 26 evaluator files
- "Too few arguments" missing `exn`: fixed ~40+ call sites across
  evaluator/exprs, evaluator/types, evaluator/calls, evaluator/builtins,
  and evaluator/values
- `&(env)/&(ctx)` type mismatches: removed `&()` from Environment/EvalContext
  object params (object references already share state)
- `io.async((io, exn) => ...)` closure params: changed to `(io) =>` (Exn
  handler auto-captured from scope) — fixed in 11 files

**Blocked:**

- Async support files (`target.yo`, `fetch.yo`, `version_cache.yo`, etc.)
  have `io.await()` design issues (parameter-passing patterns for async
  effects that need deeper review). These are runtime files, not evaluator
  files, but block `check` because they're imported by `process.yo` via
  `_expr.yo`.
- ~50 `io.async` sites across 11 non-evaluator files; param count fixed
  but inner `io.await`/effect-handling call patterns need work.
- Evaluator files that don't transitively import async support files
  likely pass `check` now; blocked at first async dependency.

### The port exists and is actively maintained

- `yo-self/evaluator/` mirrors `src/evaluator/` 1-to-1 (same subdirs:
  `async/ builtins/ calls/ ctfe/ effects/ exprs/ shared/ types/ utils/
values/`).
- `yo-self/main.yo` wires the **proper** ported evaluator
  (`evaluator/exprs/_expr.yo`, `evaluator/context.yo`,
  `evaluator/values/anonymous_module.yo`) into `run_check`.
- Leaf modules (`token.yo`, `lexer.yo`, `expr.yo`) still `check` cleanly
  under the current TS `yo-cli`.

### But many call sites have drifted from their own definitions

`./yo-cli check yo-self/main.yo` currently **FAILS**, and a per-file
`check` sweep (2026-05-27, using exit codes) shows the drift is
**widespread but highly uniform**. The breakdown:

| Error category                            | Approx. sites                                     | Meaning                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **"Too few arguments for function call"** | ~88                                               | A call passes fewer args than the yo-self function's own definition expects — almost always a **missing threaded-effect argument** (usually `exn : Exception`, yo-self's explicit form of TS's native `throw`; sometimes `io : Io`). |
| "Expected 1 regular parameters, got 2"    | 3 (`cache.yo`, `compiler_utils.yo`, `process.yo`) | A different arity mismatch.                                                                                                                                                                                                          |
| "Expected to be evaluated"                | 2 (`await_analysis.yo`, `suspension_analysis.yo`) | Evaluator-state expectation.                                                                                                                                                                                                         |
| "Cannot reassign 'expected_env'"          | 1 (`synthesizer.yo`)                              | Reassignment of a non-reassignable binding.                                                                                                                                                                                          |
| Slice-flowability (raw pointer in return) | 1 (`asm.yo`)                                      | The newer `plans/SLICE_FLOWABILITY.md` rule — a return type carries a raw pointer and must be rooted.                                                                                                                                |

Concrete example (the dominant pattern): `prohibit_void_type` is
**defined** in `yo-self/types/utils.yo:146` as
`(fn(ty : TypeValue, token : Token, exn : Exception) -> unit)` — the
3rd `exn` parameter is yo-self's exception-effect threading. Four call
sites pass `exn` correctly; `evaluator/exprs/binding.yo:171` omits it:

```
prohibit_void_type(user_defined_type, ast_expr_token(rhs));   // ✗ missing exn
prohibit_void_type(final_type, ast_expr_token(expr), exn);    // ✓ field.yo:541
```

**Important: this is NOT `src/` drift.** yo-self defines its own
versions of these functions; the failures are _internal_ — a call site
not matching its own definition, typically a leftover from an
incomplete edit when `exn`-threading was added. So the fix is local and
mechanical, not a re-port.

**The ~88 number overstates the root cause.** `check` stops at the
first error and reports the whole import chain, so most failing files
fail only because they _import_ a broken leaf (e.g. `binding.yo`,
`begin.yo`, `values/impl.yo`). Fixing the root-cause leaves bottom-up
cascades green to all their importers. The true root-cause set is
smaller and is discovered iteratively (fix innermost error → re-check →
next). Until `yo-self/main.yo` checks clean, **`yo-self-bin` cannot be
built at all** — this is the Phase 0 gate.

### The prebuilt binary is stale

`yo-self/yo-self-bin` predates the `check` subcommand
(`unknown subcommand 'check'`). It must be rebuilt once the drift is
repaired.

### Historic `check` capability (last working binary)

Per [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md), a previously-built
`yo-self-bin` could `check`:

- The full `std/prelude.yo` (1040+ exprs).
- Simple programs: literals, fns, `assert`, struct+impl+method dispatch,
  generic structs, `Option`/`Result`+`match`, traits with generic
  fn-type fields.
- 88% (22/25) of real-test extracts from `./tests/*.test.yo`.

The known evaluator-level failures (the gap to 100%) are catalogued in
[Known blockers](#known-evaluator-blockers).

---

## Strategy: strict 1-to-1 port

Continue the existing structural port. Per the project rule (and
`MEMORY.md`):

- Each `src/**/*.ts` file has a same-named `yo-self/**/*.yo`
  (`-`↔`_`, `camelCase`↔`snake_case`). These naming differences are
  mechanical, not divergences.
- Each exported TS function has a same-named Yo function with an
  equivalent body.
- **No yo-only files that diverge from the TS codebase.** The legacy
  proto evaluator `yo-self/evaluator/eval.yo` (~8.2k lines) is exactly
  such a divergence and is slated for retirement (see
  [Cross-cutting cleanup](#cross-cutting-cleanup)).
- Validate changes with `./yo-cli check`, **not** by running
  `yo-self/tests/` (many of those are pre-existing-broken for reasons
  unrelated to a given change).

### Drift-repair loop (Phase 0)

```bash
# 1. Find the next drift point.
./yo-cli check yo-self/main.yo 2>&1 | head -30
# 2. Open the failing yo-self file + its src/ counterpart; reconcile the
#    signature/behaviour (e.g. add the missing prohibit_void_type arg).
# 3. Repeat until `check yo-self/main.yo` is clean.
```

### Build + check loop (Phases 1–3)

```bash
ulimit -s 65520                                   # see stack-overflow blocker
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin   # NO --release (faster loop)
/tmp/yo-self-bin check std/prelude.yo             # smoke
/tmp/yo-self-bin check ./std                      # corpus
```

`--release` is reserved for the final validation build — it makes the
iteration loop too slow during porting.

---

## Phases

### Phase 0 — Un-rot: yo-self builds again

This is the unblocking gate: until `yo-self/main.yo` checks clean,
`yo-self-bin` cannot be built. Work is mechanical reconciliation of the
call-site drift catalogued above (mostly: add a missing `exn`/effect
argument so each call matches its own definition).

**Exit criteria:**

- `./yo-cli check yo-self/main.yo` passes (all drift repaired).
- `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin` succeeds.
- `/tmp/yo-self-bin check <trivial.yo>` returns "evaluator OK".

#### Repair recipe (per failing call site)

1. `ulimit -s 65520` (once per shell — see the stack-overflow blocker).
2. `./yo-cli check yo-self/main.yo 2>&1 | head -40` — read the **innermost**
   `Error:` and its `file://…yo:line:col` (the deepest one, not the
   import-chain frames printed after it).
3. Open that yo-self file at that line, and open the **definition** of
   the called function (grep `<fn_name> ::` in `yo-self/`). Compare the
   call's args to the definition's params.
4. Almost always: the call is missing the trailing `exn` (or `io`)
   handler that the definition takes. Add the in-scope handler argument
   (the enclosing function already threads it — copy from a sibling call
   site that passes it correctly).
5. Re-run step 2. The same file usually reveals its next missing-arg
   site; once a leaf file is clean, its importers stop failing on it.

For the non-"Too few arguments" buckets (see the table above), fix per
the specific error: the `Expected 1 regular parameters` arity sites, the
`Expected to be evaluated` sites, the `synthesizer.yo` reassignment, and
the `asm.yo` slice-flowability return (root the returned slice in a
`ref`-bound parameter per `plans/SLICE_FLOWABILITY.md`).

#### Prioritized worklist — fix bottom-up (dependency order)

`check` follows imports and stops at the first error, so fix the most
**foundational** files first; that cascades green to everything that
imports them. Order by dependency tier (import-frequency in parens):

1. **Tier 1 — Foundational** (imported by nearly everything):
   `expr.yo` (39), `types/definitions.yo` (12), `token.yo` (7),
   `types/creators.yo` (7), `types/guards.yo` (6), `types/tags.yo` (4),
   `types/utils.yo`, `error.yo`, `value.yo`/`value_b.yo`,
   `function_value.yo`, `env.yo`, `utils.yo`, `compiler_utils.yo`.
2. **Tier 2 — Evaluator core + type synthesis:**
   `evaluator/context.yo` (7), `evaluator/trait_checking.yo`,
   `evaluator/type_of.yo`, and `evaluator/types/*`
   (`function.yo`, `field.yo`, `struct.yo`, `enum.yo`, `record.yo`,
   `trait.yo`, `synthesizer.yo`, `closure.yo`, `newtype.yo`,
   `object.yo`, `tuple.yo`, `union.yo`, `fn_trait.yo`, `utils.yo`).
3. **Tier 3 — Expr handlers** (`evaluator/exprs/*`):
   `binding.yo` (6), `begin.yo` (5), `cond.yo`, `match.yo`,
   `assignment.yo`, `initialization_assignment.yo`,
   `destructuring_assignment.yo`, `property_access.yo`, `recur.yo`,
   `subtype_of.yo`, `c_include.yo`, `extern.yo`, `_expr.yo` (the
   dispatch hub — fix last in this tier).
4. **Tier 4 — Calls + values:**
   `evaluator/calls/*` (`function.yo`, `helper.yo`, `comptime_fn.yo`,
   `closure_type.yo`, `index_trait.yo`, `iso.yo`, `type.yo`) and
   `evaluator/values/*` (notably `impl.yo`, `anonymous_function.yo`,
   `anonymous_module.yo`).
5. **Tier 5 — Builtins / ctfe / effects / async** (`evaluator/builtins/*`,
   `evaluator/ctfe/*`, `evaluator/effects/*`, `evaluator/async/*`,
   `evaluator/shared/*`). These are leaves for `check` purposes.
6. **Tier 6 — Root:** `evaluator/index.yo`, then `main.yo`. When `main.yo`
   checks clean, build `yo-self-bin` and move to Phase 1.

> The legacy `evaluator/eval.yo` proto (~8.2k lines) is on this list only
> because a few files still import it; prefer migrating those importers
> to the proper ported modules and deleting `eval.yo` over repairing its
> drift (see [Cross-cutting cleanup](#cross-cutting-cleanup)).

#### Re-measuring progress

Re-run the per-file sweep to watch the failing-file count drop as
foundational tiers are fixed:

```bash
ulimit -s 65520
for f in $(find yo-self -name '*.yo' -not -path '*/tests/*' | sort); do
  ./yo-cli check "$f" >/dev/null 2>&1 || echo "FAIL $f"
done | tee /tmp/yoself_drift.txt | wc -l
```

### Phase 1 — `yo-self-bin check ./std`

**Exit criteria:** every file under `./std` checks cleanly under
`yo-self-bin`, matching the TS `yo-cli check ./std` result (151/151).

Likely work:

- **Cross-module isolation.** yo-self currently uses a
  flatten-all-exprs shortcut instead of TS's per-module sub-evaluation +
  caching (`src/evaluator/index.ts`, `module-manager.ts`). Real `./std`
  has multi-file modules with privacy and (some) circular imports; the
  shortcut is not equivalent. This is the largest Phase 1 item.
- **Stack overflow.** The recursive evaluator carries large by-value
  structs and blows the default 8 MB macOS stack at ~40–50 frames
  (`ulimit -s 65520` is the current workaround). A real fix (box large
  frames / reduce by-value copying / raise the runtime's own thread
  stack) is needed for std files deeper than the prelude. See
  [`issues/yo-self-evaluator-stack-overflow.md`](../issues/yo-self-evaluator-stack-overflow.md).
- Std-specific evaluator paths surfaced by the broader corpus.

### Phase 2 — `yo-self-bin check ./tests`

**Exit criteria:** `yo-self-bin check ./tests` matches TS `yo-cli check
./tests` (every test file type-checks; note `check` does not _run_
tests, only evaluates them).

Likely work — the evaluator paths behind the historically-failing test
extracts (all evaluator-only; their codegen counterparts are out of
scope):

- where-clause trait-eval throw propagation
  ([`issues/yo-self-where-clause-trait-eval-segfault.md`](../issues/yo-self-where-clause-trait-eval-segfault.md))
- nested TypeApplication in impl return
  ([`issues/yo-self-nested-typeapp-in-impl-return-segfault.md`](../issues/yo-self-nested-typeapp-in-impl-return-segfault.md))
- impl fn parametric return
  ([`issues/yo-self-impl-fn-parametric-return-sigsegv.md`](../issues/yo-self-impl-fn-parametric-return-sigsegv.md))
- `TypeValue` variants too narrow for some ports
  ([`issues/yo-self-typevalue-variants-too-narrow-for-stub-ports.md`](../issues/yo-self-typevalue-variants-too-narrow-for-stub-ports.md))
- HKT-heavy and GADT evaluator paths (`higher_kinded_types`, `gadts`).
- Enum-eval memory leak (correctness under repeated eval)
  ([`issues/yo-self-evaluator-enum-memory-leak.md`](../issues/yo-self-evaluator-enum-memory-leak.md)).

Async/effects test files: `check` only type-checks them, so the **async
runtime / effects runtime codegen is NOT required** — only the
evaluator's effect-analysis paths (`evaluator/effects/`) must be
faithful.

### Phase 3 — `yo-self-bin check ./yo-self` (self-check fixpoint)

**Exit criteria:** `yo-self-bin check ./yo-self` passes — the
self-hosted evaluator validates its own source.

This is the headline milestone. It transitively requires Phases 0–2
(yo-self uses std, and its own idioms overlap the test corpus). Expect a
tail of evaluator features that only yo-self's own source exercises
(large match statements, deep generic instantiation, the
`ExprInfo`/`ExprId` side-table patterns).

A natural stretch target after Phase 3: **fixpoint** — `yo-self-bin
check ./yo-self` produces the same result as `./yo-cli check ./yo-self`,
and a yo-self built by yo-self-bin also passes (once codegen lands, out
of scope here).

---

## Known evaluator blockers

| Blocker                                                             | Issue                                                     | Phase |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| API/syntax drift vs current `src/`                                  | (this doc)                                                | 0     |
| Recursive evaluator stack overflow (~40–50 frames)                  | `yo-self-evaluator-stack-overflow.md`                     | 1     |
| Cross-module isolation = flatten shortcut (not per-module sub-eval) | (this doc / `BOOTSTRAPPING.md` §C)                        | 1     |
| where-clause trait-eval throw-propagation segfault                  | `yo-self-where-clause-trait-eval-segfault.md`             | 2     |
| nested TypeApplication in impl return segfault                      | `yo-self-nested-typeapp-in-impl-return-segfault.md`       | 2     |
| impl fn parametric return SIGSEGV                                   | `yo-self-impl-fn-parametric-return-sigsegv.md`            | 2     |
| `TypeValue` variants too narrow for stub ports                      | `yo-self-typevalue-variants-too-narrow-for-stub-ports.md` | 2     |
| enum-eval memory leak                                               | `yo-self-evaluator-enum-memory-leak.md`                   | 2     |

(The `yo-self-codegen-*` and `yo-self-bin-rebuild-segfaults-*` issues are
codegen concerns — out of scope for the `check` goal, though the rebuild
issue should be re-checked since it is a year old and the toolchain has
moved on substantially.)

---

## Cross-cutting cleanup

- **Retire `yo-self/evaluator/eval.yo`** (~8.2k-line legacy proto
  evaluator). It is a bootstrap-only divergence from the strict 1-to-1
  rule. It is still imported by a handful of files
  (`evaluator/utils.yo`, `evaluator/index.yo`,
  `evaluator/values/anonymous_function.yo`, `types/hierarchy.yo`,
  `codegen/exprs.yo`). Migrate those call sites to the proper ported
  modules, then delete `eval.yo`. Do this opportunistically as Phases
  1–3 touch the affected files; it is not a gate.
- Keep `BOOTSTRAPPING.md` as the **full** self-hosting record (incl.
  codegen). This document is the evaluator/`check` slice; update both
  when status changes.

---

## Success criteria (summary)

1. `./yo-cli check yo-self/main.yo` passes (drift repaired). _(Phase 0)_
2. `yo-self-bin` builds from `yo-self/main.yo`. _(Phase 0)_
3. `yo-self-bin check ./std` matches `yo-cli check ./std`. _(Phase 1)_
4. `yo-self-bin check ./tests` matches `yo-cli check ./tests`. _(Phase 2)_
5. `yo-self-bin check ./yo-self` passes — evaluator self-check fixpoint.
   _(Phase 3)_

---

## References

- [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md) — full self-hosting plan/status
  (incl. codegen), file-mapping table, component port progress.
- [`yo-self/README.md`](../yo-self/README.md) — quick start, the
  `ulimit -s 65520` requirement.
- `issues/yo-self-*.md` — per-blocker diagnoses.
- `MEMORY.md` notes: strict 1-to-1 port; validate with `check` not the
  pre-broken yo-self tests; no `--release` during the porting loop.
