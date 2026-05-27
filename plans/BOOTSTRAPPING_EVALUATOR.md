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

### The port exists and is actively maintained

- `yo-self/evaluator/` mirrors `src/evaluator/` 1-to-1 (same subdirs:
  `async/ builtins/ calls/ ctfe/ effects/ exprs/ shared/ types/ utils/
values/`).
- `yo-self/main.yo` wires the **proper** ported evaluator
  (`evaluator/exprs/_expr.yo`, `evaluator/context.yo`,
  `evaluator/values/anonymous_module.yo`) into `run_check`.
- Leaf modules (`token.yo`, `lexer.yo`, `expr.yo`) still `check` cleanly
  under the current TS `yo-cli`.

### But it has rotted against the current TS compiler

`./yo-cli check yo-self/main.yo` currently **FAILS**. The port drifted
as `src/` evolved. First failure observed:

```
yo-self/evaluator/exprs/binding.yo:171
  prohibit_void_type(user_defined_type, ast_expr_token(rhs));
  Error: Too few arguments — expected 3, got 2
```

i.e. `prohibit_void_type` gained a parameter in `src/` and the yo-self
call site wasn't updated. Because `check` stops at the first error,
**the full extent of the drift is unknown** until each error is fixed
and the next surfaces. Given yo-self was last touched 2026-05-25, the
drift is recent and likely small — but it is a hard gate: **until
`yo-self/main.yo` checks, `yo-self-bin` cannot be built at all.**

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

**Exit criteria:**

- `./yo-cli check yo-self/main.yo` passes (all drift repaired).
- `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin` succeeds.
- `/tmp/yo-self-bin check <trivial.yo>` returns "evaluator OK".

This is the unblocking gate. Work is mechanical reconciliation of API
drift (changed signatures, tightened syntax such as strict-parens and
the memory-safety pragmas, renamed builtins) between `yo-self/` and the
current `src/`. Enumerate by iterating the drift-repair loop.

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
