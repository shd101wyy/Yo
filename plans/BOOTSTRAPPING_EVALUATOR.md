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

| Milestone                                                  | Status          | Number                                                          |
| ---------------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| `./yo-cli check yo-self/main.yo`                           | green           | —                                                               |
| `./yo-cli compile yo-self/main.yo`                         | builds          | —                                                               |
| `/tmp/yo-self-bin check std/prelude.yo`                    | green           | —                                                               |
| `/tmp/yo-self-bin check ./std` (per-file)                  | **green**       | **151 / 151 files OK**                                          |
| `/tmp/yo-self-bin check ./tests` (per-file)                | **green**       | **156 / 182 files OK** (per-file; the "170" was directory-mode) |
| `/tmp/yo-self-bin check ./yo-self` (per-file, excl. tests) | **in progress** | **51 / 223 files OK** (after comptime memoization; see Phase 3) |

> **Phase 1 complete** — per-file `check ./std` matches the TS reference
> (151/151). This session closed every remaining gap: comptime
> operator-trait dispatch (9 `net/*`/`sys/*`/`http/*` files), the
> nested-import preload gap (`env.yo`, `os/env.yo`, `fs/temp.yo`),
> associated-type resolution on an enum receiver (`encoding/json.yo`'s
> `Self.Output`), and the build builtins + comptime-string default
> coercion (`build.yo`) — all below.

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

### Phase 1: **complete** — `yo-self-bin check ./std` (151/151)

**Headline number:** per-file `check ./std` is at **151 / 151** —
**Phase 1 complete** (matches TS `yo-cli check ./std`). Progression:
0 → 44 (per-module isolation, `ctx.load_module`) → 137 (spread-export /
global-id / primitive-registry fixes) → 146 (comptime operator-trait
dispatch, the 9 `net/sys/http` files) → 149 (recursive **nested**-import
preload, the `env.yo`/`os/env.yo`/`fs/temp.yo` `./libc/stdlib` gap) →
150 (associated-type resolution on an enum receiver,
`encoding/json.yo`'s `Self.Output`) → 151 (`build.yo`: the
`evaluate_yo_build_functions` dispatch + a comptime-string default-value
coercion fix). The long-suspected "deep-eval stack overflow" turned out
to be a misdiagnosis (the genuine stack overflow is fixed; see below).

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
**DONE — 151/151 per-file.**

Work completed (in order of impact):

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
4. **Nested-import preload — DONE.** `env.yo`/`os/env.yo`/`fs/temp.yo`
   imported `./libc/stdlib` from _inside_ an `impl({...})` body; the
   preload DFS only scanned **top-level** imports, so `libc/stdlib.yo`
   was never cached → `evaluate_import` failed with "module not
   preloaded". Added `collect_import_paths_recursive`
   (`codegen/driver.yo`) — recursively collects every import path
   reachable from an expr (nested in impl/module/begin bodies) — and used
   it at both preload sites in `main.yo` (`preload_module_tree`'s
   post-order walk and `check_single_file`'s entry walk). Took per-file
   `check ./std` **146 → 149**.
5. **Associated-type resolution on enum receiver — DONE.**
   `encoding/json.yo`'s `impl(JsonValue, Index(String)(Output : JsonValue,
index : (fn(…) -> *(Self.Output))(…)))` evaluated `Self.Output` where
   `Self` = the `JsonValue` enum. The TypeVal+EnumT property-access branch
   threw `Enum variant "Output" not found in enum` before any
   associated-type lookup. Added `_try_resolve_associated_type`
   (`evaluator/exprs/property_access.yo`) — checks the env (during
   generic-impl specialization) then the type-trait-methods registry
   (where `Output : JsonValue` is registered under JsonValue's id) — and
   called it in the EnumT not-found branch before throwing. Took per-file
   `check ./std` **149 → 150**.
6. **Build builtins + comptime-string default coercion — DONE.**
   `build.yo` hit two issues. (a) `evaluate_yo_build_functions` was a
   "not yet implemented" stub. Implemented the dispatch
   (`evaluator/builtins/build.yo`): args are pre-evaluated in `_expr.yo`
   (mirrors TS), then each `__yo_build_*` builtin validates its arguments
   and returns the correct comptime TYPE — `comptime_string` for
   `target_host`/`target_parse`/`option`/`dep_module`, `unit` otherwise,
   plus the trial-evaluation early return (`target_host` → host triple,
   `option` → "", else unit) used during function-definition
   type-checking. The `BuildRegistry` population is build-runner behavior
   (out of scope, and even TS skips it on the trial path), so the
   handlers don't mutate the registry. (b) `convert_comptime_type_to_
runtime_type_with_expected` (`types/env_lookup.yo`) coerced a
   `comptime_string` value to `str` even when the expected type was
   itself `comptime_string`, so `(comptime(x) : comptime_string) ?= "…"`
   failed its default-value check (`Expected comptime_string, Got <str>`).
   Added a guard to keep the comptime type when the expected type is
   `comptime_string`. Took per-file `check ./std` **150 → 151**.

### Phase 2 — `yo-self-bin check ./tests` (in progress)

**Exit criteria:** `yo-self-bin check ./tests` matches TS `yo-cli check
./tests` (every test file type-checks; note `check` does not _run_
tests, only evaluates them).

**Baseline (2026-05-29).** Per-file sweep over the 170 `tests/*.test.yo`
files (the `.yo_test_batch_*.yo` artifacts and `circular_deps/*` error
tests are excluded — TS fails those by design):

| Compiler      | `*.test.yo` pass rate                                            |
| ------------- | ---------------------------------------------------------------- |
| TS (`yo-cli`) | **170 / 170** (was 169; `derive_clone_complex` fixed — see note) |
| `yo-self-bin` | **11 / 170** (Phase 2 in progress; 8 at start)                   |

> Note: `derive_clone_complex.test.yo` was failing TS too — a flowability
> false positive introduced earlier this session (the assignment-escape
> check didn't traverse `.Some(...)`/`&+`). Fixed in `src/`; TS is now
> 170/170. Also, `yo check` now skips dot-prefixed `.yo` files
> (auto-generated `.yo_test_batch_*` artifacts) in both the TS and
> yo-self directory walkers.

So the Phase 2 target is **169 / 170** (matching TS). The 162 failures
cluster by root cause (first-error sampling):

1. **Default-argument application at call sites — DONE (infra).** A call
   like `assert(x == 10)` to `assert :: (fn(flag : bool, (msg : str) ?=
"Assertion failed.") -> unit)` was rejected with `Argument count
   mismatch: expected 2, got 1` — no notion of optional (defaulted)
   params at the call site. Since `TypeValue.Func` carries no per-param
   default info (and a new field touches ~105 positional `.Func(...)`
   match sites), this was solved with a **func-id-keyed side-table** of
   per-parameter default values (mirroring the macro registry):
   `FuncParam.default_value` is captured at definition,
   `evaluate_function_type` registers it by the `fn(...)` type-expr id,
   `try_to_implement_function_by_function_type` re-keys it under the
   FuncVal id, and both call paths (the inline FuncVal arm in
   `calls/function.yo` and `try_to_call_function_with_arguments` in
   `helper.yo`) allow `n_args ∈ [n_required, n_params]` and bind omitted
   optionals to their recorded default value. Verified: `assert(1 == 1)`
   checks clean; std stays 151/151. **Headline note:** the per-file
   `check ./tests` count is still 8/170 — the assert _layer_ is cleared
   (files now reach their _next_ gap), but the corpus has deeper layered
   gaps (below), so first-error progress doesn't yet flip files to green.
2. **Template-string `to_string` dispatch — DONE.** A backtick template
   `` `text` `` desugars to `("text".to_string)()`; the self arg is a
   `comptime_string` matched against `to_string`'s `Self = str`. In
   `check_if_function_parameter_matches_argument` (`helper.yo`),
   `synthesize_types` ran on the RAW arg type and rejected the `str` vs
   `comptime_string` tag mismatch **before** the step-8 compatibility
   coercion (and `comptime_string` has no `to_string` of its own — it
   relies on the comptime*string→str coercion). Fixed by coercing the
   arg's comptime type to the parameter's concrete runtime type before
   synthesis — **guarded** to fire only when the param type is a genuine
   runtime concrete type, never a `SomeT` nor a comptime type
   (`convert*…`lowers comptime_int→i32 unconditionally, so an unguarded
version regressed std 151→17). Took per-file`check ./tests`**8 → 11**;
std stays 151/151. (Two improvements landed en route: unique expr ids
for template sub-exprs, and`type_to_string`renders empty-named
structs as`<struct:ID>`.)
3. **Array length inference `Array(T, _)`** — explicitly unimplemented in
   the self-hosted compiler (`array.test.yo`): "Array length inference
   with `_` is not supported".
4. **Comptime `while` condition** — `array_list.test.yo`: "while loop
   condition is compile-time known but the `comptime` modifier is
   missing" (yo-self over-strictly requires `while(comptime(...))` when
   the condition folds to a constant).
5. **`dyn(...)` concrete→trait-object coercion — DONE.** `(err :
AnyError) = dyn(`x`)` failed (`Cannot unify "<String>" and
"dyn(Error)"`): `evaluate_dyn_value` evaluated its inner expression
   with the raw dyn target as `expected_type`, so the inner's concrete
   return type was matched against the dyn and reached `synthesize_types`
   (tag mismatch). Fixed by evaluating the inner with a fresh `SomeT`
   carrying the dyn's traits (or cleared, when the outer expected isn't a
   dyn), mirroring TS `evaluateDynValue`. std stays 151/151.
   5b. **dyn method dispatch — DONE.** `err.source()` on a `dyn(Error)`
   receiver failed `Type mismatch for parameter "self": Expected Self :
   ((to_string …)) Got dyn(Error)`. Two faithful-port gaps, both fixed:
   (a) **supertrait expansion** — `evaluate_dyn_type`
   (`yo-self/evaluator/types/dyn.yo`) had deferred the self-constraint
   expansion, so `Dyn(Error)` carried only `[Error]`, not `[Error,
   ToString]` (Error has `where(Self <: ToString)`). Ported the BFS over
   `TraitT.self_constraints` (mirrors `src/evaluator/types/dyn.ts:88-104`).
   (b) **SomeT-vs-Dyn compatibility** — `are_types_compatible`
   (`yo-self/types/compatibility.yo`) rejected a `DynT` arg against a
   `SomeT` param (the tag-mismatch guard fired before the structural
   match). Added the `isSomeType(actual) && isDynType(expected)` rule
   _before_ the tag guard: each of the SomeT's required traits must be
   satisfied by some trait the dyn carries (mirrors
   `src/types/compatibility.ts:662-684`). NB: the SomeT-binding/resolution
   path (`get_value_of_some_type_from_env`) does **not** resolve this case
   — the param's `Self` SomeT has `frame_level=3` but the callee env has
   only 2 frames, so frame-keyed lookup misses; TS likewise relies on the
   direct compat rule, not resolution. std stays 151/151; TS green.
   5c. **test-body trial-eval errors not swallowed → 36 SIGSEGVs — DONE.**
   The `error.test.yo` `comptime_int`/`i32` error (and the bulk of the
   `./tests` crashes) was NOT a deep layered gap but a single root cause:
   (a) `evaluate_test` did not swallow trial-evaluation errors the way TS's
   `evaluateTest` wraps the trial in `try { … } catch {}` (trial errors are
   non-fatal — the test-block context takes a different inference path than
   the real `main` wrapper; e.g. a call to a locally-defined
   `cond`-with-`throw` fn fails in the trial but compiles fine in `main`).
   (b) `evaluate_initialization_assignment` evaluated the `:=` rhs through
   the _non-raw_ `evaluate_expression`, whose `_evaluate_expression_wrapper`
   **catches, prints, and continues with a placeholder expr** instead of
   propagating — so the trial error was printed (`evaluate_expression:
   Cannot unify …`) and evaluation continued with a bogus expr → SIGSEGV.
   Fix: `evaluate_test` trial-evaluates via a helper that installs a local
   swallowing handler (`unwind`), drops the two non-TS throws (“Failed to
   evaluate test body”, “Test body must have unit type”), and restores the
   env frame stack; `evaluate_initialization_assignment` uses the
   exn-threading `evaluate_expression_raw` so rhs errors propagate to that
   handler. Mirrors TS (`evaluateExpression` propagates; `evaluateTest`
   try/catches). Result: per-file `check ./tests` **46/82 → 81/82**
   (35 files CRASH→OK, **0 regressions**, 0 clean failures); std stays
   151/151; TS green.
   5d. **More non-raw `evaluate_expression` leaks (imm_threading) — DONE.**
   The same class as 5c: a spurious trial-eval error (`Cannot unify "usize"
   and "unit"` from `while(runtime(i < <runtime-usize>), …)` in a test
   block) leaked through a non-raw `evaluate_expression` that the test-body
   swallow couldn't catch. Converted the remaining non-raw calls in the
   while-condition/body path to `evaluate_expression_raw` (threads `exn`):
   `evaluate_runtime` (the `runtime(...)` arg — the actual leak),
   `evaluate_assignment` (the `=` lhs + 2 rhs sites), and `while`'s
   step-expr eval. Per-file `check ./tests` (all 170, incl. subdirs)
   **169/170** (`imm_threading` CRASH→OK, **0 regressions**, 0 clean
   failures); std 151/151; TS green. Pattern note: yo-self's non-raw
   `evaluate_expression` (the `_evaluate_expression_wrapper`) is a
   bootstrap-diagnostics divergence — it catches+prints+continues instead
   of propagating like TS's `evaluateExpression`; any evaluator fn holding
   an `exn` whose sub-eval error must reach the caller should use
   `evaluate_expression_raw(…, exn)`.
   5e. **Self-referential-trait substitution recursion (io/reader_writer) —
   DONE → Phase 2 COMPLETE (170/170).** The last `./tests` crash was a
   pure SIGSEGV (no diagnostic): impl-matching a trait method whose
   parameter is `Dyn(Error)` (= `AnyError`; `Error.source` returns
   `Option(Dyn(SelfTrait))`, forming a **cyclic** `DynT → TraitT → … →
   DynT` TypeValue graph). `_substitute_self_in_method_ty` →
   `substitute` (`yo-self/types/substitution.yo`) walked that cyclic graph
   with no cycle guard → infinite recursion → stack overflow. (Regular
   fns with an `Exception` param don't hit this; only trait-method impl
   Self-substitution does — so std, which never impls a trait with such a
   param, was unaffected.) Fix: add a `visited_trait_ids` set to the
   `Substitution` object (fresh per top-level `substitute`, threaded
   automatically since `s` is passed to every recursive call) and guard
   the `TraitT` case — if a trait id is already being recursed into,
   return it unchanged. Re-descending into an already-visited trait's
   methods is also semantically unnecessary (those carry the _trait's_
   own `Self`, not the impl receiver's). **`check ./tests` 170/170 —
   matches TS**; std 151/151; **0 regressions**. Phase 2 done.

The historically-tracked extracts below are a subset of #4:

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

**Baseline (2026-05-30):** per-file `check ./yo-self` (223 `.yo` files,
excluding `yo-self/tests/` which is pre-existing-broken) = **51 OK / 170
FAIL / 2 CRASH** _(classify by EXIT CODE — 0/1/139 — not by grepping
"evaluator OK", because the prelude's own `"std/prelude.yo — evaluator
OK"` line precedes the target file's verdict and would mis-count errored
files as OK)._

**ONE dominant root cause** (≈all 170 FAILs + the 2 crashes share it):
`Incompatible types: Expected <struct…> / Given unit` on a module-level
typed runtime global `(g_x : HashMap(...)) = HashMap(...).new()` /
`(g_x : ArrayList(...)) = ArrayList(...).new()` — which nearly every
compiler file declares.

**Corrected root cause (an earlier struct-vs-object framing was a
grep artifact — always classify by exit code):** a static method
(`.new()`, and in fact ANY method) on a **GENERIC type instantiation**
(`G(usize)`) resolves to `unit`. Struct vs object is irrelevant; non-generic
vs **generic** is the axis. Two caveats that fooled earlier runs:

- **yo-self `check` does NOT type-check ordinary `fn` bodies** (only
  module-level statements, `test` blocks, comptime). Deliberate type
  errors inside `main`'s body still exit 0. So "fn-level works" results are
  vacuous — the generic `.new()` is simply never checked there. Module-level
  globals are the one spot it IS checked, which is why they surface it.
- `:=` "passes" because it doesn't type-check the rhs; the typed `(x:T) =`
  / module global is what checks it.

**Mechanism:** `.new()` resolves via `find_methods_from_generic_impls` →
`try_match_generic_impl` (`evaluator/values/impl.yo`), which matches the
impl receiver pattern `G(T)` against the concrete `G(usize)` via
`synthesize_types`. The synthesizer Struct case (≈line 1320) and Enum case
**throw on `exp_id != giv_id`**. `evaluate_struct_type` assigns a fresh
`struct_${random_id()}` on EVERY evaluation, so `G(T)` (id 2488) and
`G(usize)` (id 2491) never share an id → throw → no match → `unit`.

**TS does this right via `StructType.functionValue.funcId`** (set in
`comptime-fn.ts:274` `returnedType.functionValue = functionValue`; matched
in `synthesizer.ts:649-665`). yo-self's `TypeValue` has no such field — the
synthesizer.yo header even notes _"StructType.functionValue comparison
skipped … uses id only."_ THAT omission is the bug.

**Fix attempt (reverted — mechanism validated, but incomplete for stdlib):**
side table `struct_id → constructor func_id`, stamped in
`evaluate_struct_type` from the **enclosing function context**
(`ctx.is_evaluating_function_body_or_async_block.func_value` → `FuncVal`'s
`func_id`), consulted in the synthesizer Struct/Enum id-checks via a
`_same_type_constructor` helper. Findings from instrumentation:

- **The cloning fear was unfounded** — instrumenting `evaluate_struct_type`
  (`MKSTRUCT`) showed the exact ids synthesize compares (e.g. 2488 = pattern
  `G(T)`, 2491 = concrete `G(usize)`) are assigned AT CREATION, both under
  the SAME enclosing func id. So a side-table-by-id stamped at creation is
  sound; no `Struct`-field needed.
- **The mechanism works for user-defined generics:** with the registry in
  `yo-self/utils.yo` (TypeValue-free leaf — putting it in
  `definition_site_registry.yo` caused a C `redefinition` clash because that
  file imports `types/type.yo`'s `TypeValue`, a SEPARATE enum from
  `types/definitions.yo`'s), `qm` (the user-generic-object repro) advances
  PAST `.new()` — `synthesize` no longer throws at the id-check, and the
  error moves to a deeper `tmp.a : T` (field not specialized; an over-strict
  repro artifact). `SYNSTRUCT` confirms `sameconstructor=true` fires.
- **The real (stdlib) case still fails.** For `ArrayList(usize).new()`
  (`(g_a : ArrayList(usize)) = …`), the concrete struct (id 2767) IS
  registered (`fid 2213` = ArrayList's func), but **synthesize's Struct case
  is NEVER reached for giv=2767** — so `.new()` on a stdlib generic
  resolves via a DIFFERENT path than `try_match_generic_impl` (almost
  certainly `evaluate_property_access`'s **type-trait-methods registry**,
  keyed by a SPECIFIC instantiation id: `new` was registered under
  `ArrayList(T)`'s id and the lookup uses `ArrayList(usize)`'s id → miss →
  `unit`). The synthesizer funcid-match can't help a path that never calls
  synthesize.

**funcid-stamping + registry-dedup approach: RULED OUT (3rd attempt,
reverted, with HARD per-file data).** Implemented the full thing —
`g_type_constructor_funcid` side table in `utils.yo`; struct-creation
stamping (from `ctx.is_evaluating_function_body_or_async_block.func_value`);
`_same_type_constructor` guard in synthesizer Struct + Enum id-checks;
layer-2 receiver-pattern stamping in `impl.yo`; and the requested
registry-dedup in `register_generic_impl` (`g_registered_generic_impl_keys`,
keyed by `ctorFuncId:traitKey:methodNames`). Built the binary, then ran a
rigorous **per-file diff of a fix binary vs a HEAD-baseline binary** over
`./std`, `./tests`, and `./yo-self` (classified by exit code). Result:

| corpus  | baseline OK | fix OK | improved | regressed                               |
| ------- | ----------- | ------ | -------- | --------------------------------------- |
| std     | 151         | 151    | 0        | 0                                       |
| tests   | 156         | 154    | 0        | 2 (`imm_vec`, `imm_threading` → SIGBUS) |
| yo-self | 50          | 50     | 0        | 0                                       |

**(Note: the true `./yo-self` baseline is 50, not the 51 recorded earlier.)**

Two conclusive facts:

1. **It does not resolve the target.** The blocking error on a representative
   file is **byte-identical** with and without the fix:
   `Incompatible types: Expected <struct:…> / Given unit` at
   `yo-self/evaluator/values/type_trait_methods.yo:130` —
   `(_type_trait_methods : HashMap(String, ArrayList(MethodEntry))) =
HashMap(...).new()`. So the stamps are **not connecting** the generic
   receiver pattern to its concrete instantiation for the real stdlib
   generics; `.new()` still resolves to `unit` exactly as before.
2. **It spuriously connects unrelated structs**, deterministically crashing
   `imm_vec`/`imm_threading` with **SIGBUS (signal 10)**. The coarse
   struct-creation stamping gives two unrelated structs created under the
   same enclosing fn the same `func_id`, so `_same_type_constructor`
   returns true where the id-mismatch throw was correct; synthesize then
   recurses fields and loops on recursive generics (its cycle guard
   `_has_type_pair` keys on **non-stable random_ids**, never matching —
   whereas TS guards by **Type object identity**, `pair.expected ===
expected.type`, synthesizer.ts:234–243).

**Why the stamps don't connect for stdlib (the real open question):** even
with layer-2 stamping the receiver pattern and struct.yo stamping the
concrete, `.new()` on `HashMap(...)`/`ArrayList(...)` did not flip — which
means EITHER the pattern/concrete are not both reaching the side table with
the same `func_id`, OR `.new()` resolves through a path that never consults
`_same_type_constructor` (it returned `unit` identically). The earlier
finding that synthesize's Struct case is **never reached for the stdlib
concrete** (no `SYNSTRUCT` for `giv=ArrayList(usize)`) points to the latter:
stdlib `.new()` resolves via a different path, so the synthesizer guard is
irrelevant to it.

**INSTRUMENTATION PASS + attempt #4 (DONE, reverted) — the mechanism is now
fully understood AND proven to be a dead end for the count.** Gated
`eprintln`s in `find_methods_from_generic_impls` (+ a `[NEWIMPL]` dump of
every `new`-defining impl's receiver-pattern id vs the concrete id) and
property_access branch 721 pinned down the exact failure for
`HashMap(String, ArrayList(MethodEntry)).new()` at `type_trait_methods.yo`:

- `total_entries=104, entries_defining_new=3, matched=2, results=0`. The 3
  `new`-defining impls (receiver ids `2015/2215/2495`) ALL failed to match
  the concrete (`3659`); the 2 that matched don't define `new`. So
  **HashMap's own impl fails to unify `HashMap(K,V)` against
  `HashMap(String,X)`** — the synthesizer Struct case throws on the raw
  random-id mismatch (yo-self structs are nominally anonymous;
  `type_to_string` renders both as `<struct:id>`).
- **`func_id` IS stable** here: `func_id := "fn_"+random_id(...)` is fresh
  per _evaluation_ (same as TS, anon-function.ts:681), BUT modules ARE
  cached (`module_loader.yo`), so HashMap's FuncVal is shared between
  impl-registration and the use site → same `func_id`. The dedup premise of
  attempt #3 was WRONG: `entries_defining_new=3` proves **no duplication**.
- Attempt #3's stamps didn't connect because `struct.yo` gates on
  `is_evaluating_function_body_or_async_block` but the live comptime
  type-fn call path doesn't always populate it consistently. **The correct,
  faithful stamp site is the comptime-fn CALL site** — `function.yo`'s
  FuncVal-callee branch (~line 1165, right after `out.value =
body_info.value`), mirroring `comptime-fn.ts:259–276`
  (`returnedType.functionValue = functionValue`). Stamping the returned
  Struct/Enum id → the **called** FuncVal's `func_id_fv` there is non-coarse
  (only the returned type) and connects BOTH the impl receiver `HashMap(K,V)`
  and the use-site `HashMap(String,X)` (both call the same cached FuncVal).

**Attempt #4** did exactly that (call-site stamp in `function.yo` +
`_same_type_constructor` guard in `synthesizer.yo`, NO `struct.yo`/`impl.yo`
changes). Result, validated by the per-file diff harness:

| corpus  | base OK | #4 OK | improved | regressed                                            |
| ------- | ------- | ----- | -------- | ---------------------------------------------------- |
| yo-self | 50      | 50    | **0**    | 0                                                    |
| tests   | 156     | 153   | **0**    | **3** (`imm_vec`, `imm_threading`, `priority_queue`) |

- **It WORKS** — `[NEWIMPL]` shows HashMap's impl `2495` now `matched=Y` vs
  concrete `3659`; the `type_trait_methods.yo` error moves PAST `.new()` to a
  **deeper** gap: `Expected enum type or primitive type for match
expression, got unit`.
- **But it flips ZERO files**: every affected file has a deeper layered gap
  behind method resolution, so resolving `.new()` alone never reaches OK.
- **And it regresses recursive generics** to SIGBUS. `imm/vec` is NOT itself
  recursive (`object(_ptr:*(T),_len,_cap)`), so the runaway is the prelude's
  recursive types cascading once `_same_type_constructor` opens same-
  constructor field-recursion. Crucially the recursion is **NOT in
  `_synthesize_call`** — a `checked.len() > 256` bound there **never fired**
  — so it lives in a synthesize-callee (substitute / `_bind_some_type` /
  `get_value_of_some_type_from_env`) or re-enters via the _public_
  `synthesize_types` (fresh `checked`).

**ROOT CAUSE of the whole layer:** yo-self does **not memoize comptime type
instantiations** (no `calledComptimeFunctionCaches`), so every `Vec(i32)` /
`HashMap(K,V)` call yields a fresh struct id. TS gets stable per-
instantiation identity from its comptime cache + `functionValue` object
identity, which is what makes its synthesize recursion terminate. The
`func_id` side table reconstructs _constructor_ identity (enough to match
two instantiations) but cannot make the cycle guard terminate without
per-instantiation memoized identity.

**LANDED (`663fca9f`) — comptime-instantiation memoization (+1).** The full
memoization (`evaluate_comptime_fn_call` + `ctx.comptime_fn_caches`, keyed by
func_id + arg values) EXISTED but was DEAD: the live FuncVal-callee path in
`function.yo` inlined the body eval instead of delegating, so every
`Vec(i32)`/`HashMap(K,V)` call produced a fresh struct id (the TS divergence —
`helper.ts` delegates to `evaluateComptimeFunctionCall`). Wired it in:
`function.yo`'s FuncVal branch now routes type-returning calls
(`is_type_hierarchy_type(ret_type)`) through `evaluate_comptime_fn_call`.
Fixed three latent bugs in the never-exercised `comptime_fn.yo` (immutable-
param reassign `callee_env`→local; unsupported in-place ArrayList element
write → remove+push). Per-file diff: **std 151→151, tests 156→156 (no
regressions), yo-self 50→51** (`utils.yo` flips). First Phase-3 gain,
regression-free, faithful to TS. **Bonus:** memoization makes the SIGBUS
regressors (`imm_vec`/`imm_threading`/`priority_queue`) terminate — stable
per-instantiation ids let the synthesize cycle guard catch recursion — so it
also unblocks the funcId-match approach from crashing.

**funcId match ON TOP of memoization — STILL doesn't land (reverted).** Re-
applied the side table + `_same_type_constructor` guard + a stamp inside
`evaluate_comptime_fn_call` (where the returned type is finalized). Result:
no SIGBUS (memoization fixed that), BUT yo-self 51→50 — `.new()` STILL
resolves to `unit` (`type_trait_methods.yo` shows `Given unit`), unlike
attempt #4's inline-path stamp which DID make it resolve. So routing the
comptime call through `evaluate_comptime_fn_call` changed something that
breaks the stamp's effectiveness for method resolution — the synthesize that
resolves `.new()` apparently operates on a struct id that is NOT the one
stamped in `comptime_fn.yo` (substituted/cloned copy? different eval path?).
The −1 was self-inflicted (the side table's own `HashMap.new()` in
`utils.yo` hit the same unresolved-`.new()` bug). NET: 0 gain + regress →
reverted.

**ROOT CAUSE pinpointed (instrumented `[STAMP]`+`[STC]` build, reverted).**
Stamped the returned type at the `function.yo` call site after the
delegation returns (mirroring attempt #4) and logged every
`_same_type_constructor` call. Decisive line:
`[STC] exp=struct_yo_id_2315 ef=yo_id_2196 giv=struct_yo_id_3044 gf=- res=F`.
Every `HashMap` instantiation stamps consistently to `yo_id_2196` (the
generic-impl receiver **pattern** `2315` included, `ef=yo_id_2196`), but the
**concrete the synthesizer compares (`3044`) is NEVER stamped** (`gf=-`).
`3044` is created during the failing global's own evaluation — the type
ANNOTATION `(_type_trait_methods : HashMap(String, ArrayList(MethodEntry)))`
— via a path that bypasses BOTH `function.yo`'s FuncVal-callee delegation
AND `evaluate_comptime_fn_call` (separate type-expression construction, or a
substituted/cloned copy that drops the side-table entry). So
`_same_type_constructor(pattern, concrete)` = F → `.new()` stays `unit`.
This is also why stamping inside `evaluate_comptime_fn_call` (earlier
sub-attempt) failed identically — the annotation concrete never reaches it.
(Side note: the side table cannot be a module-level `HashMap(...).new()` OR
`ArrayList(...).new()` global in any file that must `check`-pass — that
global hits the very unresolved-`.new()` bug; both forms failed `utils.yo`.)

**NEXT STEP:** find the type-ANNOTATION / binding-type evaluation path that
constructs the concrete `HashMap(String, ArrayList(MethodEntry))` (`3044`)
— likely a type-expression evaluator calling the comptime fn via
`helper.yo`'s `try_to_call_function_with_arguments` rather than
`function.yo`'s `evaluate_function_call` — and stamp the result THERE; OR,
if `3044` is a clone/substitution of a stamped struct, make
`substitute()`/the clone copy the side-table entry to the new id. The rest
of attempt #4's chain already works (matched=Y → error moves deeper), so
connecting the concrete's stamp is the last missing link for `.new()`.

**STRATEGIC VERDICT:** generic method resolution is **necessary but a dead
end on its own** — it moves the count by 0 across 4 attempts (memoization is
a SEPARATE, landed win). Two viable
forward paths, in priority order:

1. **Clear the deeper gaps first.** The next concrete blocker behind
   `.new()` is `type_trait_methods.yo`'s `Expected enum type or primitive
type for match expression, got unit`. Fix the layers a file actually
   stacks (deepest reachable first) until at least one file flips — only
   then is the method-resolution layer worth landing alongside them.
2. **Memoize comptime type instantiations** (port TS's
   `calledComptimeFunctionCaches` into `function.yo`'s FuncVal-callee
   branch). This is the architectural root fix: it makes `Vec(i32)` a single
   shared TypeValue, which (a) gives the synthesizer real identity so
   same-constructor matching terminates (no SIGBUS), and (b) likely makes
   `.new()` resolve _without_ the funcid side table at all. Bigger change,
   but it removes the regression class entirely.

**Do NOT re-apply the funcid stamp + `_same_type_constructor` guard alone** —
it is proven net-negative (0 improved / 3 regressed). Validate ANY Phase-3
change with the baseline-vs-fix per-file diff harness (capture `$? $file`
per file, `join` on filename); aggregate counts hid the 0-improved result
three times.

_(ENV: `bun` keeps dropping from PATH; set
`BUN=/nix/store/*-bun-1.3.3/bin/bun` for `./yo-cli`/commits.)_

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
| Nested imports not preloaded: `import(...)` inside `impl({...})` body skipped by top-level-only preload walk (`./libc/stdlib`)  | (this doc — Phase 1 item 4)                               | 1     | fixed (`collect_import_paths_recursive`)                        |
| Associated type on enum receiver: `Self.Output` errored as a missing enum variant before assoc-type lookup (`encoding/json.yo`) | (this doc — Phase 1 item 5)                               | 1     | fixed (`_try_resolve_associated_type` in EnumT branch)          |
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

1. ✅ `./yo-cli check yo-self/main.yo` passes (drift repaired). _(Phase 0)_
2. ✅ `yo-self-bin` builds from `yo-self/main.yo`. _(Phase 0)_
3. ✅ `yo-self-bin check ./std` matches `yo-cli check ./std` (151/151). _(Phase 1)_
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
