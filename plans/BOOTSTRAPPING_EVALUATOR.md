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
yo-self-bin check ./yo-self   # Phase 3: EVALUATOR-ONLY — excludes yo-self/codegen/ (and yo-self/tests/)
```

`check` runs **lexer → parser → evaluator** (type-check, CTFE, trait
resolution) and stops before codegen. So this goal isolates the
evaluator: when `yo-self-bin check`'s on its own **evaluator** source pass,
the self-hosted evaluator can validate itself — a true evaluator-level
self-hosting fixpoint. **Phase 3 is scoped to the evaluator + support files
and EXCLUDES `yo-self/codegen/`** (a later bootstrap phase whose ports are
likely stale); see the scope note under "Current state". The bar is to
match the TS reference (`./yo-cli check`) on that set, not codegen.

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

## Current state (updated 2026-06-09)

> **Phases 0–3 COMPLETE.** All defined `check`-milestone phases now match (or,
> for tests, match-modulo-feature-gaps) the TS reference. Measure all directory
> checks **per-file by exit code** — full-directory mode SIGSEGVs on cross-file
> state pollution (a harness limitation, not an evaluator bug).

| Milestone                                | Status       | Number                                         |
| ---------------------------------------- | ------------ | ---------------------------------------------- |
| `./yo-cli check yo-self/main.yo`         | green        | —                                              |
| `./yo-cli compile yo-self/main.yo`       | builds       | —                                              |
| `yo-self-bin check ./std` (per-file)     | **complete** | **151 / 151** (matches TS)                     |
| `yo-self-bin check ./tests` (per-file)   | **complete** | **173 / 182** (9 fail — feature-gap clusters)  |
| `yo-self-bin check ./yo-self` (per-file) | **complete** | **228 / 228** (self-check fixpoint reached)    |
| `yo-self-bin check ./yo-self/codegen`    | deferred     | out of Phase 3 scope (a later bootstrap phase) |

> **Def-eval-wall era (2026-06).** Since the table above was first written, the
> def-time fn-body-eval wall was crossed (memory `yo-self-defeval-wall`,
> `EVALUATOR_PORT_REVIEW.md` flowability entry): non-generic fn bodies are now
> evaluated at definition time (faithful to `function-type.ts:499`), made safe by
> a swallowing trial-eval wrapper. That surfaced — and this work has been closing
> — the **in-body definition-time gates** (flowability, etc.) that `check` alone
> never exercised. `tests` rose 164 → 173 over this era. The 9 remaining `tests`
> fails: circular_deps ×4 (error identically to TS), algebraic_effects, sync/mutex,
> extern_unsafe_wrap, and **2 flowability** (ref_local_binding, ref_closure_capture
> — need the ref-capture-escape check, blocked by yo-self deferring _closure_ body
> eval). **ref_flowability + slice_flowability are CLOSED** (2026-06-10); see the
> flowability note below.

> **Phase 3 fixpoint reached (227/227).** The generic-instantiation identity
> knot that dominated Phase 3 was resolved (comptime-fn cache collision —
> `are_types_compatible_exact` + structural struct comparison; commit
> `e3936a98`), along with the circular-import loader rearchitecture (`85480c76`)
> and the reassignable-`ref`-param fix (`bf10a166`). The self-hosted evaluator
> now validates its own evaluator source.
>
> **`check ./tests` — the 19 remaining fails are feature-gap clusters, not port
> drift** (per-file, 2026-06-02):
>
> - **circular_deps (4)** — `circular_b`, `circular_error_a/b`, `circular_open_b`:
>   genuinely unresolvable import cycles; **error identically to the TS
>   reference**, so not a yo-self defect.
> - **flowability — `ref_flowability` + `slice_flowability` ✅ CLOSED; 2 still failing.**
>   slice*flowability closed 2026-06-10 via: (a) a TS-first fix to `isFlowableExpr`
>   for QUALIFIED variant ctors `Enum.Variant(args)` (commit 3fa201d6 — a real TS
>   false-positive; `./yo-cli check` rejected asm.yo too) + its yo-self port
>   (ac9734d2); (b) the in-body slice/ref flow checks (return/explicit-return/
>   assignment, commit 6a681f82); (c) the recorded-`ExprInfo.env` aliasing fix
>   (f6fa7132); (d) the keystone — coercing a `comptime_string` cond arm to runtime
>   vs a `str` expected return (commit 5e67cd07), which let `assign_escape_slice`'s
>   body def-evaluate past its cond so the assignment-escape check fires. The 2
>   remaining (`ref_local_binding`, `ref_closure_capture`) need the
>   ref-capture-escape check, blocked by yo-self deferring *closure* body eval.
>   The def-time fn-body-eval wall was crossed (memory `yo-self-defeval-wall`), so
>   the call sites now run. `ref_flowability` was closed by three coordinated
>   faithful fixes (commit `454b14ca`): (1) binding-site flow-violation re-raise
>   through the capture-free trial-eval swallow (global flag-box + def-time-caller
>   re-raise); (2) return-position fallback to the raw body when the trial eval was
>   swallowed; (3) **cond.yo `isPtrRelaxedMatch`** (cond.ts:352) — a `*(T)`
>   ref-return expected type accepts a cond arm yielding raw `T`. Plus the
>   operator/comptime-routing gate (`a4977828`) and the R3 method-callee side-table
>   (`308c854d`, fixes ref-returning \_method* calls in `-> ref` returns). **Still
>   failing: `ref_local_binding`, `ref_closure_capture`** (need the ref-capture-
>   escape check, blocked by yo-self deferring _closure_ body eval → no precise
>   free-var set; `issues/yo-self-flowability-swallow.md`) **and `slice_flowability`**
>   (a long tail of distinct positive-case gaps — first is `comptime_str`, blocked
>   by recorded-`ExprInfo.env` aliasing + begin `pop_frame`;
>   `issues/yo-self-recorded-env-aliasing.md`).
> - **comptime arithmetic — ✅ Tier 1 done (cf6219f0)** — `comptime_ref` now
>   passes (`n + usize(1)` types as `usize`, not `unit`). Tier 1 = correct
>   typing (operator → trait dispatch via `string_is_operator`, gated on
>   comptime operand; `Self.Output` resolved via receiver registry). Tier 2
>   (actual value folding `5+1=6` via `evaluate_comptime_fn_call`) still open —
>   see `plans/COMPTIME_ARITHMETIC_FOLDING.md`.
> - **ref-type eval (subset of ref\_\*)** — `ref_return`: `Failed to evaluate type
expression: ref(i32)`; `ref_local_binding`: destructuring on `i32`. Distinct
>   ref-type/destructuring gaps, not flowability.
> - **structural gates (5)** — `safe_code_structural_gates`, `thread_safety`,
>   `sync/mutex`, `negative_impl`, `extern_unsafe_wrap`.
> - **type features (2)** — `gadts`, `higher_kinded_types` (`F(A)`).
> - **effects (1)** — `algebraic_effects`.
>   Each cluster is a dedicated post-phase feature effort, tracked for the review.
>
> **Evaluator port is file-complete EXCEPT one file:** every TS evaluator module
> (`src/evaluator/**`, 130 files) has a `yo-self/` counterpart **except
> `types/flowability.ts`** (confirmed by full scan). The earlier claim that
> `types/flowability` was ported was incorrect.

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
- **Data types must be ported faithfully too — not just functions.** When a
  TS interface field is dropped or flattened in the yo-self `TypeValue`, the
  algorithms that depend on it cannot be ported faithfully, and working
  around the gap with side tables / proxy predicates leads to dead ends.
  **Cautionary example (the generic-`.new()` saga, Phase 3):**
  `StructType.functionValue` and `FunctionParameter.isCompileTimeOnly` were
  dropped from yo-self's `TypeValue`; ~8 attempts to reconstruct them
  externally (a `func_id` side table, `is_type_hierarchy_type` proxy gates)
  all failed, because the missing fields don't travel with the type through
  substitution/specialization the way the real fields do. The fix is to
  restore the fields (see Phase 3 "UPSTREAM ROOT CAUSE"), not to work around
  them. When porting, prefer reproducing the TS data structure exactly over a
  "simpler" flattened shape.

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

### Phase 2 — `yo-self-bin check ./tests` — **complete (169/170, matches TS)**

**Exit criteria (met):** per-file `yo-self-bin check ./tests` matches TS
`yo-cli check ./tests` (every test file type-checks; `check` evaluates, does
not run, tests). Progression: 8 → 169/170 over the session.

**Fixes landed (all regression-neutral, std stayed 151/151):**

- **Default-argument application at call sites** — func-id-keyed side-table of
  per-param defaults (`FuncParam.default_value`), since `TypeValue.Func` carries
  no per-param default info; both call paths bind omitted optionals to the
  recorded default.
- **Template-string `to_string` dispatch** — coerce the arg's comptime type to
  the param's concrete runtime type before `synthesize_types` (guarded to fire
  only for genuine runtime concrete params, never `SomeT`/comptime — an
  unguarded version regressed std 151→17).
- **`dyn(...)` concrete→trait-object coercion + dyn method dispatch** — evaluate
  the inner with a trait-carrying `SomeT` expected type; supertrait expansion in
  `evaluate_dyn_type`; a `SomeT`-vs-`Dyn` rule in `are_types_compatible` before
  the tag-mismatch guard.
- **Self-referential-trait substitution cycle guard** — `Error.source` returns
  `Option(Dyn(SelfTrait))`, forming a cyclic `DynT→TraitT→…→DynT` graph;
  `substitute` looped → SIGSEGV. Added `visited_trait_ids` to `Substitution`.

**Key reusable learning (the swallow→crash class — recurred several times):**
yo-self's NON-raw `evaluate_expression` (`_evaluate_expression_wrapper`) is a
bootstrap-diagnostics divergence — it **catches + prints + continues with a
placeholder** instead of propagating like TS's `evaluateExpression`. A
sub-eval error swallowed there leaves a bogus expr → downstream SIGSEGV. Any
evaluator fn holding an `exn` whose sub-eval error must reach the caller should
use `evaluate_expression_raw(…, exn)`. This single pattern (plus `evaluate_test`
swallowing trial-eval errors like TS's `try/catch`) turned ~36 `./tests`
crashes into clean per-file results. (Same class fixed circular_deps in Phase 3,
`d2732a2f`.) Memory: `yo-self-test-trial-eval-swallow`.

**Out of scope for `check`:** async/effects test files are only type-checked,
so the async/effects-runtime _codegen_ is not required — only the evaluator's
`evaluator/effects/` analysis paths must be faithful.

### Phase 3 — `yo-self-bin check ./yo-self` (self-check fixpoint) — **COMPLETE (227/227)**

**Exit criteria:** `yo-self-bin check ./yo-self` passes — the self-hosted
evaluator validates its own source. This is the headline milestone; it
transitively requires Phases 0–2. **Reached: 227/227 per-file (2026-06-02).**

**Resolution path (2026-06):** the generic-instantiation identity knot that
dominated this phase (≈170 fails) was NOT nested-generic identity as first
theorized — it was a **comptime-fn cache collision**: `_ctfe_args_equal`'s
concrete branch used lenient `are_types_compatible` and `compatibility.yo`
compared structs by (empty) name, so `(?*)(Bucket)` wrongly hit a cached
`(?*)(ME)`. Fixed with `are_types_compatible_exact` for cache keys +
structural struct comparison under `require_exact` (commit `e3936a98`).
Combined with the demand-driven circular-import loader (`85480c76`) and the
reassignable-`ref`-param fix (`bf10a166`), the fixpoint was reached.

**History (2026-06-01):** per-file `check ./yo-self` was **53 OK / 172
FAIL / 2 CRASH** at the start of this phase (classify by **exit code**
0/1/139, never by grepping "evaluator OK" — the prelude's own OK line
precedes the target's verdict).

> **Measurement:** `check ./yo-self` (and `./tests`) SIGSEGV in
> **full-directory mode** — cross-file state pollution accumulated across ~200
> files, entangled with prelude-populated global registries (a harness
> limitation, NOT an evaluator bug). **Single files and subdirs check fine.**
> Always measure **per-file by exit code**. The `tests/circular_deps/` crash
> was a separate swallow→crash bug, fixed in `d2732a2f` (`evaluate_open` now
> uses the propagating raw evaluator).

**The dominant blocker (≈170 of 172 FAILs): the generic-instantiation
identity knot.** Nearly every compiler file transitively imports
`type_trait_methods.yo:130`'s `(_type_trait_methods : HashMap(String,
ArrayList(MethodEntry))) = HashMap(...).new()`, which fails
`Incompatible types: Expected <HashMap> / Given unit` — so one root cause
cascades to ~170 files.

Root cause: synthesizing a generic type that contains an RC/newtype field
(e.g. `String`) recurses into its **unstamped nested generic instantiations**
(`Option(ArrayList(u8))`), which lack stable per-instantiation identity, so the
synthesizer descends into their field lists and hits a misaligned mismatch.
TS avoids this via `StructType.functionValue.funcId` (per-instantiation type
identity) + memoized comptime instantiation; yo-self's batch/inline construction
path produces fresh-id instantiations that don't match.

**Clean minimal repro (isolated 2026-06-01, no HashMap):**

```rust
M :: (fn(comptime(K) : Type) -> comptime(Type))(object(x : K));
impl(forall(K : Type), M(K), make : (fn(v : K) -> Self)(Self(x : v)));
(_m : M(String)) = M(String).make(String.from("hi"));   // "Cannot unify i32 and usize"
```

`M(i32)` works, `M(String)` fails; returning `i32` works, returning `Self`
(with a `String` field) fails. Full diagnosis + recommended approach in
[`issues/phase3-nested-generic-instantiation-identity.md`](../issues/phase3-nested-generic-instantiation-identity.md).

**Foundation LANDED (regression-neutral, contributes to the eventual fix):**

- `663fca9f` — comptime-instantiation memoization (wired the dormant
  `evaluate_comptime_fn_call` + `ctx.comptime_fn_caches`).
- `0d4e951f` — `constructor_func_id` on `TypeValue.Struct` (= TS
  `StructType.functionValue.funcId`); compared in the synthesizer's struct case.
- `755d54f9` — `result_is_comptime_only` on `TypeValue.Func`.
- `0f2189f6` — `type_arguments` on `TypeValue.Struct` (= TS `StructType.env`);
  populated at the comptime-fn stamp site, substituted through, consumed in the
  forall-binding fallback.
- `8067aa03` — bind impl-level `forall(K,V)` into a matched method's closure
  captures during generic-impl dispatch (fixes `sizeof(Bucket(K,V))` in
  `_alloc_with_capacity`).
- `198d481f` — propagate the declared return type as the body's
  `ctx.expected_type` (fixes enum-variant-shorthand inference in tail `match`
  arms).

**✅ RESOLVED (2026-06, commit `e3936a98`).** The knot was misdiagnosed as a
per-instantiation-identity problem. The real root was a **comptime-fn cache
collision**: `_ctfe_args_equal` used lenient `are_types_compatible` for concrete
cache keys, and `compatibility.yo` compared structs by their (always-empty) name
— so a later `(?*)(Bucket(...))` instantiation hit a cached `(?*)(ME)` entry. Fix:
`are_types_compatible_exact` for cache-key identity + structural struct
comparison under `require_exact`. The Stage-4 stamping rabbit-hole below was
chasing the wrong root cause.

**The original (wrong) framing, kept for history — Stage 4 "open knot":** give
nested generic instantiations stable per-instantiation identity so the
synthesizer matches them by constructor and never recurses into their fields —
WITHOUT re-breaking recursive-type termination (ad-hoc stamping re-SIGBUS'd
recursive generics `imm_vec`/`imm_threading`).

**⚠ History: ~12 incremental attempts (funcId side-table, stamp+guard,
call-site stamp, routing refactor) were all net-≤0 or SIGBUS-prone — see git
history and memory `yo-self-phase3-generic-impl-funcid`. DO NOT re-apply the
funcId-stamp + `_same_type_constructor` guard as a standalone workaround.**
Cracking it needs a genuine per-instantiation-identity design, validated with a
**per-file baseline-vs-fix exit-code diff** (the aggregate count has hidden
"0 improved" multiple times). The `param_is_comptime` over-CTFE angle was also
tried and reverted (regressed `check ./std` 151→71; see memory
`yo-self-html-knot-phantom`).

---

## Known evaluator blockers

| Blocker                                                                                                                         | Issue                                                          | Phase | Status                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| API/syntax drift vs current `src/`                                                                                              | (this doc)                                                     | 0     | fixed                                                                 |
| Multi-file cached prelude lost all bindings (`pop_frame` at end of `evaluate_anonymous_module_begin_exprs`)                     | (commit `d9566b76`)                                            | 1     | fixed                                                                 |
| `usize.MAX` / primitive-type impl fields (`type_id_or_empty` returned `""` for primitives; lookup branch was struct/union-only) | (commit `4cef2a17`)                                            | 1     | fixed                                                                 |
| Whole-env module value: `import("…")` returned the entire env, breaking spread-export (`Element X already exported`)            | (commit `32307361`)                                            | 1     | fixed (per-module loader)                                             |
| Relative `..` import resolved with `Path.join` (no `..` collapse) → wrong path                                                  | (commit `32307361`)                                            | 1     | fixed                                                                 |
| Recursive evaluator stack overflow (yo-self needed `ulimit -s 65520`)                                                           | `yo-self-evaluator-stack-overflow.md`                          | 1     | fixed (1 GiB worker thread, `6aff3bd7`)                               |
| Comptime operator-trait dispatch: `==`/`<`/… type as `unit` not `bool` (9 net/sys/http files)                                   | (this doc — resolved-blocker section)                          | 1     | fixed (infix dispatch + parametric-trait lookup + `Self` subst)       |
| Cross-module isolation parity vs TS `module-manager.ts` (circular-import partial values, privacy)                               | (this doc / `BOOTSTRAPPING.md` §C)                             | 1     | partial — per-module eval works; cycle/privacy parity TBD             |
| Nested imports not preloaded: `import(...)` inside `impl({...})` body skipped by top-level-only preload walk (`./libc/stdlib`)  | (this doc — Phase 1 item 4)                                    | 1     | fixed (`collect_import_paths_recursive`)                              |
| Associated type on enum receiver: `Self.Output` errored as a missing enum variant before assoc-type lookup (`encoding/json.yo`) | (this doc — Phase 1 item 5)                                    | 1     | fixed (`_try_resolve_associated_type` in EnumT branch)                |
| Test-body trial-eval errors not swallowed + non-raw `evaluate_expression` swallow→crash (≈36 `./tests` SIGSEGVs)                | (Phase 2; memory `yo-self-test-trial-eval-swallow`)            | 2     | fixed (`0f3007c8`, `13a5bb4a`)                                        |
| Self-referential-trait substitution recursion (`Error.source` cyclic `DynT→TraitT`)                                             | (Phase 2)                                                      | 2     | fixed (`9b67b199`, `visited_trait_ids` cycle guard)                   |
| Circular import (`open(import b)` before `b` preloaded) → swallow→SIGSEGV in `evaluate_open`                                    | (Phase 3 — `d2732a2f`)                                         | 3     | fixed (raw eval; circular imports still don't _resolve_)              |
| Full-directory `check` SIGSEGV (cross-file state pollution; prelude-populated registries)                                       | (Phase 3 — measurement note)                                   | 3     | known limitation — measure per-file by exit code                      |
| **Generic-instantiation identity knot** (`.new()`/method on a generic type → `unit`; ≈170 `./yo-self` fails)                    | `issues/fixed/phase3-nested-generic-method-resolution-unit.md` | 3     | **✅ fixed (`e3936a98`) — comptime-fn cache collision, not identity** |

(Several earlier Phase-2 issue docs — `yo-self-where-clause-trait-eval-segfault`,
`yo-self-nested-typeapp-in-impl-return-segfault`,
`yo-self-impl-fn-parametric-return-sigsegv`,
`yo-self-typevalue-variants-too-narrow-for-stub-ports`,
`yo-self-evaluator-enum-memory-leak` — were the historical `./tests` cluster;
Phase 2 reached 169/170 via the swallow-pattern + cycle-guard fixes above, so
they no longer block the count and may be stale. The `yo-self-codegen-*` and
`yo-self-bin-rebuild-segfaults-*` issues are
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
4. ✅ `yo-self-bin check ./tests` (172/182 as of 2026-06-09; the 10 remaining are
   feature-gap clusters that error identically to / are wall-blocked vs TS). _(Phase 2)_
5. ✅ `yo-self-bin check ./yo-self` passes (228/228) — evaluator self-check
   fixpoint reached (the generic-instantiation identity knot was resolved as a
   comptime-fn cache collision, `e3936a98`). _(Phase 3)_

**Post-fixpoint work (def-eval era):** the active effort is now completing the
**in-body definition-time gates** surfaced by crossing the def-eval wall — see
`EVALUATOR_PORT_REVIEW.md` (flowability cluster) and the remaining `tests`
clusters. ref_flowability closed 2026-06-09; ref-capture-escape and
slice_flowability remain, each blocked on a distinct deeper gap (closure-body
eval; recorded-env aliasing).

---

## References

- [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md) — full self-hosting plan/status
  (incl. codegen), file-mapping table, component port progress.
- [`yo-self/README.md`](../yo-self/README.md) — quick start. (The
  `ulimit -s 65520` requirement is obsolete as of `6aff3bd7`.)
- `issues/yo-self-*.md` — per-blocker diagnoses.
- `MEMORY.md` notes: strict 1-to-1 port; validate with `check` not the
  pre-broken yo-self tests; no `--release` during the porting loop.
