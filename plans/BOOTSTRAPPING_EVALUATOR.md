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

## Current state (updated 2026-05-29)

| Milestone                                 | Status          | Number                 |
| ----------------------------------------- | --------------- | ---------------------- |
| `./yo-cli check yo-self/main.yo`          | green           | —                      |
| `./yo-cli compile yo-self/main.yo`        | builds          | —                      |
| `/tmp/yo-self-bin check std/prelude.yo`   | green           | —                      |
| `/tmp/yo-self-bin check ./std` (per-file) | **in progress** | **146 / 151 files OK** |
| `/tmp/yo-self-bin check ./tests`          | not yet run     | —                      |
| `/tmp/yo-self-bin check ./yo-self`        | not yet run     | —                      |

> The 146/151 figure is the **per-file** pass rate (each file checked in
> its own process). The comptime operator-trait dispatch blocker (the 9
> `net/*`/`sys/*`/`http/*` files) is now **fixed** — see below. The
> remaining 5 failures are unrelated evaluator-coverage gaps:
>
> - **`build.yo`**: `evaluate_yo_build_functions` not yet implemented.
> - **`env.yo`, `os/env.yo`, `fs/temp.yo`**: `./libc/stdlib` import gap.
> - **`encoding/json.yo`**: pointer-argument evaluator gap.
>
> Each failing file crashes (SIGSEGV) only as a _secondary_ effect:
> `_evaluate_expression_wrapper` prints the gap error then unwinds with a
> placeholder and limps on until a downstream access faults.

### Phase 0: **complete** — all drift repaired, main.yo passes

```bash
./yo-cli check yo-self/evaluator/index.yo → evaluator OK
./yo-cli check yo-self/main.yo              → evaluator OK
```

**Fixes applied (7 commits, ~55 files):**

- **"Cannot reassign env/env_mut"**: field-level copies across 26 evaluator files
- **"Too few arguments" missing `exn`**: ~50+ call sites across evaluator
- **`&(env)/&(ctx)` type mismatches**: removed `&()` from object params
- **`io.async((io, exn) => ...)`**: changed to `(e : IoExn) =>` with `e.io`/`e.exn`
  (closures cannot capture CTL values: `io` and `exn` are control-bound)
- **I/O call fixes**: added missing `io` handler to `is_file/is_dir/exists/read_file/
write_file/read_dir/metadata` in formatter.yo and main.yo; IoExn futures use
  `IoExn(io : io, exn : exn)` await handler
- **`target.yo`**: simplified to synchronous, matching TS `src/target.ts`
- **`main.yo` dispatch**: converted `cond` to if/else chain (`exn.throw` returns
  `ResumeType`, can't mix with `unit` in `cond` branches)
- **`main.yo` safety**: wrapped `unsafe(exit(int(1)))`

### Phase 1: **in progress** — `yo-self-bin check ./std`

**Headline number:** per-file `check ./std` is at **137 / 151** (up from
0 at the start, then 44 mid-session). The jump from 44 → 137 came from
implementing per-module isolation (`ctx.load_module`). The remaining 14
are **evaluator-coverage gaps** — the long-suspected "deep-eval stack
overflow" turned out to be a misdiagnosis (the genuine stack overflow is
now fixed; see below). The active blocker is comptime operator-trait
dispatch (9 of the 14).

**Fixes landed this session:**

- **Multi-file prelude bindings (`d9566b76`).**
  `evaluate_anonymous_module_begin_exprs` unconditionally popped the
  module-body frame at the end. For multi-file `check`, that discarded
  every prelude binding right before `main.yo` cached the env, so each
  subsequent file cloned an env containing only an empty popped-frame
  skeleton. Symptom: `(3) Failed to evaluate type expression: Option(...)`
  on any `c_include` field that mentioned a comptime type — single-file
  worked because the prelude is concatenated into `all_exprs` there.
  Added a `keep_frame_at_end : bool` parameter; `check_single_file` passes
  `true`; `impl.yo` and `try_populate_expr_info_table` pass `false` to
  preserve existing semantics. Took the std pass-rate from **0 → 44**.

- **Primitive trait-method registry IDs (`4cef2a17`).**
  `type_id_or_empty` returned `""` for `Int/Float/Usize/Isize/Bool/C-*`
  variants, so `impl(usize, MAX : ...)` was silently skipped at
  registration time and `usize.MAX` property access never even reached
  the registry (the lookup branch was guarded on `is_struct_type ||
is_union_type`). Now primitives get synthetic ids (`__yo_t_usize`,
  `__yo_t_i32`, …) AND `evaluate_property_access` has a generic
  registry-walk branch ahead of the struct/enum-specific paths.
  `usize.MAX` now resolves correctly in multi-file mode — but the same
  files immediately hit the spread-export gap, so the headline 44/96
  is unchanged for now; this fix unblocks the layer beneath.

- **Other supporting work from earlier in the session
  (`d9566b76`'s prerequisites):**
  `Fix directory check: set env.module_path to current file path`
  (`2d5c436d`), `Fix c_include: handle Type declarations (time_t :
Type) as TypeVal` (`41047de5`), `Add prelude pre-loading for
multi-file directory checks` (`898f12ad`), and
  `Fix evaluator: ref return type, expected_type for defaults, error
reporting` (`48a2d6f9`).

- **Global AstExpr ids (`354b235b`).**
  Each Parser instance started its `next_expr_id` at 0, so file A's
  expr id N and file B's expr id N collided in the per-ctx
  `expr_info_table`. In multi-file `check`, the dep file's `i32(7)`
  at id N would silently overwrite the user file's
  `import("./...")` at id N, so the spread-export read back
  `(ty=i32, value=ModuleVal)` and rejected with
  `Expected struct type for export, got i32`. Switched to a
  per-process monotonic `g_next_global_expr_id`. Verified via 3-stage
  diagnostic: import-time saw `ty=ModuleT`, bind-time saw `ty=i32`,
  same id — definitive id-collision evidence. After this fix the
  spread-export advances past the type-check.

- **Per-module isolation via `ctx.load_module` (`32307361`).**
  The flatten-all-deps model made every `import("…")` return the whole
  visible env (via `_build_module_val_from_env`), so spread-exporting
  multiple imports tripped `Element "X" is already exported`. Replaced
  with real per-module evaluation (option 2 below):

  - `evaluator/module_loader.yo` — a `path → module_value` cache plus a
    pure `load_module_from_cache(path)` used directly as
    `ctx.load_module`. The callback must be pure (I/O cannot run inside
    it: `io` is control-bound and the signature is fixed), so it is a
    lookup over a cache populated up front.
  - `resolve_module_path` — factored out of `evaluate_import` into one
    I/O-free resolver shared by both `evaluate_import` and the
    orchestration layer, guaranteeing identical `file://` cache keys.
    Also fixed a latent `..` bug: relative imports were resolved with
    `Path.join` (which does **not** collapse `..`) instead of
    `Path.new` (which does), so `std/imm/list.yo`'s
    `import("../allocator.yo")` wrongly resolved to
    `std/imm/allocator.yo`.
  - `main.yo preload_module_tree` — post-order DFS that reads/parses
    each dependency, evaluates it in isolation against a clone of the
    cached prelude env (with `ctx.load_module` wired so its own imports
    resolve), and registers just its exports. `check_single_file` now
    preloads a file's imports, then evaluates only that file's own
    declarations.

  Took per-file `check ./std` from **44 → 137 / 151**. The legacy
  flatten path (`_build_module_val_from_env`) is retained as the
  `ctx.load_module = None` fallback still used by `run_compile` /
  `run_test`.

- **Stack overflow fixed; "net/sys = stack overflow" was a misdiagnosis
  (`6aff3bd7`).** The generated `main()` now runs the program body on a
  1 GiB-stack POSIX worker thread (`pthread_attr_setstacksize`); the
  macOS main thread is hard-capped at ~64 MiB. Verified: at the default
  8 MiB stack the old binary SIGSEGVs on `std/prelude.yo`, the new one
  exits 0 — so **`ulimit -s 65520` is no longer required**. Crucially,
  the 13 `net/sys/http` files still fail _with the big stack_, at shallow
  depth — they were never stack overflows. See the active blocker.

#### Comptime operator-trait dispatch (`==`/`<`/… → `bool`) — **FIXED**

The 9 `net/sys/http` files failed on
`Expected bool type for "or" argument, got: platform == Platform.Macos`.
`platform` and `Platform.Macos` are comptime strings; `platform ==
Platform.Macos` is a comptime `==`. yo-self did not dispatch comparison
operators to their trait impl, so `==` typed as `unit` (it fell into the
unbound-operator-name fallback in
`evaluator/exprs/identifer_and_operator.yo` → `UnknownVal(t_unit())`).
`cond` tolerates a non-`bool` condition, but `||`/`&&` and `bool`
bindings reject it.

The fix has **three** parts (commit on `feat/bootstrapping-evaluator`):

1. **Infix comparison dispatch** (`evaluator/calls/function.yo`). Added
   an early branch in `evaluate_function_call`, before callee evaluation,
   mirroring TS `function.ts`'s `stringIsOperator(name) && expr.isInfix`
   branch: for an infix comparison operator (`==`/`!=`/`<`/`<=`/`>`/`>=`),
   evaluate the first operand (with `expected_type` cleared) to get the
   receiver type, resolve the method via
   `get_receiver_methods_by_name_from_env(op, receiverType,
is_infix=true)`, and call it. **Restricted to comparison operators**:
   arithmetic/bitwise operators already lower through a separate concrete
   path in the bootstrap; routing them through generic trait dispatch
   loses the result type (`Failed to infer the function call return
type`) and regressed `sys/sysinfo.yo`'s `usize * usize`.

2. **Parametric-trait expected-type lookup** (`evaluator/values/impl.yo`,
   `_try_lookup_trait_type`). The impl `(==) : ((lhs, rhs) -> …)` is a
   **bare lambda**; its parameter types come from the _expected_ trait
   field type. But `ComptimeEq(comptime_int)` is produced by _calling_ a
   trait-constructor function (`ComptimeEq :: (fn(...) ->
comptime(Trait))(trait(...))`), so the leftmost-atom lookup found the
   constructor `FuncVal`, not a `TraitT`, returned `None`, and the lambda
   fell back to `_synthesize_default_func_type` — which mints a fresh
   `SomeT` named after each parameter label (`lhs`). Fixed by evaluating
   the full parametric-trait expression to obtain the specialized
   `TraitT` (with an atom-lookup fast path retained for non-parametric
   traits).

3. **`Self` substitution at impl registration** (`evaluator/values/impl.yo`,
   `_substitute_self_in_method_ty`). Even with the real expected type, the
   trait field type still carries the abstract `Self` SomeT. Call-time
   SomeT synthesis can't resolve it: the synthesizer binds `Self` at the
   callee's top frame, but `_chain_resolve` looks `Self` up by its
   _definition_ frame level (the stale trait-definition frame) → miss.
   Mirroring TS's `SelfType: receiverType` substitution, the impl now
   substitutes `Self` → the concrete receiver type in each method's
   function type before binding the lambda, so the stored method type is
   fully concrete (`fn(comptime(lhs) : comptime_int, …) -> comptime(bool)`)
   and the call-site parameter check compares concrete types directly.

Also improved the call-site `Type mismatch for parameter` diagnostic
(`evaluator/calls/helper.yo`) to print `Expected`/`Got` type strings.

Result: per-file `check ./std` went **137 → 146** (the 9 `net/sys/http`
files now pass; `sys/sysinfo.yo` no longer regresses). Verified against
`/tmp/repro_psb.yo` (`v :: (__yo_pointer_size_bits() == 32)`) and prelude
(`std/prelude.yo`, exit 0); TS `yo-cli check ./std` stays 151/151.

### Strategy: strict 1-to-1 port

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
# ulimit no longer needed since 6aff3bd7 (eval runs on a 1 GiB worker thread)
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
**Current: 137/151 per-file.**

Remaining work, in order of expected impact:

1. **Comptime operator-trait dispatch — DONE.** Comparison operators
   (`==`/`!=`/`<`/…) on comptime values now dispatch to their trait impl
   and type as `bool`. Three-part fix (infix dispatch + parametric-trait
   expected-type lookup + `Self` substitution at impl registration); see
   the resolved-blocker section above. Took per-file `check ./std`
   **137 → 146**.
2. **Stack overflow — DONE (`6aff3bd7`).** Program body runs on a 1 GiB
   worker thread; `ulimit` no longer required. (Was never the net/sys
   blocker.)
3. **Per-module isolation — DONE (`32307361`).** Real per-module
   evaluation via `ctx.load_module` + cache. Remaining parity gaps vs TS
   `module-manager.ts`: circular imports (preload breaks cycles with a
   `visited` set but does not return a partial module like TS's
   `loadingModules`), and module privacy. Neither blocks std today.
4. **Other individual evaluator gaps.** `build.yo`
   (`evaluate_yo_build_functions` not implemented); `env.yo`/`os/env.yo`/
   `fs/temp.yo` (`./libc/stdlib` import); `encoding/json.yo` (pointer
   argument). Patch as encountered.

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

| Blocker                                                                                                                         | Issue                                                     | Phase | Status                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----- | --------------------------------------------------------------- |
| API/syntax drift vs current `src/`                                                                                              | (this doc)                                                | 0     | fixed                                                           |
| Multi-file cached prelude lost all bindings (`pop_frame` at end of `evaluate_anonymous_module_begin_exprs`)                     | (commit `d9566b76`)                                       | 1     | fixed                                                           |
| `usize.MAX` / primitive-type impl fields (`type_id_or_empty` returned `""` for primitives; lookup branch was struct/union-only) | (commit `4cef2a17`)                                       | 1     | fixed                                                           |
| Whole-env module value: `import("…")` returned the entire env, breaking spread-export (`Element X already exported`)            | (commit `32307361`)                                       | 1     | fixed (per-module loader)                                       |
| Relative `..` import resolved with `Path.join` (no `..` collapse) → wrong path                                                  | (commit `32307361`)                                       | 1     | fixed                                                           |
| Recursive evaluator stack overflow (yo-self needed `ulimit -s 65520`)                                                           | `yo-self-evaluator-stack-overflow.md`                     | 1     | fixed (1 GiB worker thread, `6aff3bd7`)                         |
| Comptime operator-trait dispatch: `==`/`<`/… type as `unit` not `bool` (9 net/sys/http files)                                   | (this doc — resolved-blocker section)                     | 1     | fixed (infix dispatch + parametric-trait lookup + `Self` subst) |
| Cross-module isolation parity vs TS `module-manager.ts` (circular-import partial values, privacy)                               | (this doc / `BOOTSTRAPPING.md` §C)                        | 1     | partial — per-module eval works; cycle/privacy parity TBD       |
| where-clause trait-eval throw-propagation segfault                                                                              | `yo-self-where-clause-trait-eval-segfault.md`             | 2     | open                                                            |
| nested TypeApplication in impl return segfault                                                                                  | `yo-self-nested-typeapp-in-impl-return-segfault.md`       | 2     | open                                                            |
| impl fn parametric return SIGSEGV                                                                                               | `yo-self-impl-fn-parametric-return-sigsegv.md`            | 2     | open                                                            |
| `TypeValue` variants too narrow for stub ports                                                                                  | `yo-self-typevalue-variants-too-narrow-for-stub-ports.md` | 2     | open                                                            |
| enum-eval memory leak                                                                                                           | `yo-self-evaluator-enum-memory-leak.md`                   | 2     | open                                                            |

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
- [`yo-self/README.md`](../yo-self/README.md) — quick start. (The
  `ulimit -s 65520` requirement is obsolete as of `6aff3bd7`.)
- `issues/yo-self-*.md` — per-blocker diagnoses.
- `MEMORY.md` notes: strict 1-to-1 port; validate with `check` not the
  pre-broken yo-self tests; no `--release` during the porting loop.
