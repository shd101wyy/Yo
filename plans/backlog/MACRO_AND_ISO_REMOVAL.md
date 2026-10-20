# Macro and Iso removal — comptime-only metaprogramming, Rust's thread rule

**Status:** WRITTEN 2026-10-20, not started (backlog). This is the decision
record and campaign for two maintainer decisions of 2026-10-20:

1. **Delete the macro layer.** Reverses `plans/reference/MACRO_POLICY.md`
   (2026-08-21, "keep, gate, shrink the expansion tax").
2. **Delete the builtin `Iso(T)` and `^v`.** Supersedes the `Iso` carve-outs in
   `plans/VALUES_BY_DEFAULT.md` §3.6/§3.8 and `plans/backlog/FUTURE_ORIGINS.md`'s
   "Iso stays — role unchanged".

Anchors were first verified on the 2026-10-20 tree and re-checked at this
doc's review base (`e40dc17ac` — #1485's borrow-scan re-land moved several
`src/evaluator/utils.yo` anchors); expect drift as develop moves.

## 0. The decisions, and what they honestly retract

### 0.1 No user-defined macros

Position: Yo's extension mechanisms are comptime functions, the type layer
(comptime kinds, HKT, GADTs) and the quote/reflection layer. The macro layer —
the two signature flags (`quote(p) : Expr` parameters, `-> unquote(Expr)`
returns), the func-id registries, the call dispatch, and
`Pragma.AllowMacroDef` — is deleted. What the nine live std macros do survives
as parse-time desugars or ordinary functions, following the `if` → `cond`
precedent (landed 2026-08-21; prelude `if` macro deleted 2026-08-30).

Why the 2026-08-21 "keep" verdict no longer holds — every load-bearing fact
behind `MACRO_POLICY.md` §1.5 has since changed direction:

- "`try` alone justifies the mechanism" — `try` was removed the same day
  (policy §3.1), and the proposal to restore it
  (`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3) never landed.
  Part C closes that backlog item as rejected.
- "Zig pays with builtin `if`/`for` syntax" — we accept exactly that price
  (maintainer, 2026-10-20). `if` already pays it; `for` and `for_await` join
  it in Part B.
- The forwarder macros the policy called irreducible are expressible now:
  `unsafe.drop` is a pure rename — its whole body is
  `quote(___drop(unquote(value)))` (`std/prelude.yo:247`) — and the sink/move
  parameter world of VALUES_BY_DEFAULT decisions 34/42 gives ordinary
  functions the consumption semantics the 2026-08-21 audit thought a macro
  had to provide.
- The expansion tax the policy itself named "the real maintenance pain" — the
  ~30 hand-replicated `ExprInfo.macro_expansion` chase sites, where "nothing
  enforces this; the failure mode is silent" — is still billing: an open S2
  (`issues/a-macro-that-duplicates-an-fnonce-call-calls-it-twice.md`), the
  open nested-eval corruption
  (`issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`),
  and — fixed only days ago, by re-landing a scope-aware local-borrow
  live-range scan — the module-level borrow-across-expansion S2
  (`issues/fixed/2026-10-17-a-module-level-local-borrow-is-not-checked-across-a-call-a-macro-expands-to.md`),
  on top of the earlier incident list (heap-corrupting macro dispatch, the
  275/315-error lost-expansion transpile cascades).

What survives untouched (policy §1.3, still true): `quote`, `unquote` inside
quoted code, `unquote_splicing`, `gensym`, `Expr`/`ExprList`, `EvalValue.ExprVal`,
`clone_expr_fresh_ids`, the `__yo_expr_*` reflection builtins, and all of
`derive` — that layer is comptime AST work dispatched ungated, and derive is
its biggest user. "Remove macros" removes exactly the two signature flags,
their registries, the gate, and the macro-call dispatch.

### 0.2 Rust's thread rule; no `Iso`

Position: data that crosses threads must itself be `Send`; `Rc` graphs are
thread-local. If you hold the only handle to an `Rc`, the bridge to a movable
value is `Rc.try_unwrap` — already shipped (`std/prelude.yo:9842`, Rust's
`Rc::try_unwrap` semantics on a consumed handle; `Arc.try_unwrap` at
`:10173`), a shallow single-cell check. `Iso(T)`, the `^v` operator, the
`Var.*` introspectors and the `Isolation` trait are deleted.

What this retracts, stated plainly: the one-shot, zero-atomic, zero-copy
handoff of a uniquely-owned acyclic `Rc` graph to another thread.
`try_unwrap` does not cover that case — extraction is shallow, and a graph
with interior non-atomic cells has no extractable `Send` form; that graph case
was exactly and only `Iso`'s domain (the bound rejected `Iso(i32)` as
redundant). The decision is to adopt Rust's rule — `Rc` does not cross
threads; restructure with `Arc`, rebuild into values, or serialize — and
accept those substitutes. Two facts made this the right time: nothing in
`src/` or `std/` outside the feature's own surface uses `Iso` (the
`Isolation` trait has zero callers outside the prelude), and V2b's
`Send`-by-move makes the plain-value payloads the common case, obsoleting the
docs' "use Iso until `Channel(String)` works" stopgap. A runtime
`Option`-yielding uniqueness walk was also the one runtime-proved safety
mechanism left in a language moving everything else to compile-time proof.

## 1. Inventory (tree `e40dc17ac`, 2026-10-20)

### 1.1 Macro machinery (deleted in Part C)

| Piece | Site |
| ----- | ---- |
| quoted-param / unquote-return registries | `src/evaluator/types/function.yo:99-191` (`g_macro_quoted_param_indices`, `g_macro_return_is_unquote`, `register_macro_quoted_params`, `register_macro_return_is_unquote`, `is_macro_fn`, FuncVal-id re-keying) |
| `Pragma.AllowMacroDef` gate | `src/evaluator/types/function.yo:4570-4593` (fires on `quoted_param_indices.len() > 0 \|\| is_return_unquote`) |
| gate helper + std exemption | `src/evaluator/memory_safety.yo:251-272` (`is_macro_def_capable_file`; the exemption is bootstrap-transitional, tracked at `plans/backlog/SEED_VERSION_AUTOMATION.md:51`) |
| pragma recognition | `src/evaluator/builtins/pragma.yo:39, 168-176` (variant map + AST-shape fast path) |
| call dispatch | `src/evaluator/calls/function.yo`: `MACRO_DISPATCH_ENABLED` :138, `fv_is_macro` :9155, quoted-arg binding, force-execute context flags, unquote-return splice + expansion recording :10569+ |
| `macro_expand(...)` builtin | `src/evaluator/builtins/macro_expand.yo` (278 lines; **no user call sites anywhere** — wiring: dispatch arm `src/evaluator/exprs/_expr.yo:1239-1240`, `BF_MACRO_EXPAND` `src/expr.yo:70` + export `:1057`, lexer fast path `src/token.yo:143`) |
| macro-site borrow tracking | `src/evaluator/utils.yo:6048` (`local_borrow_enter/leave_macro_site`; the `info.macro_site` diagnostic at `:5727` keys on the same machinery) |
| expansion side table | `src/expr_info.yo` (`ExprInfo.macro_expansion` :384, accessors :609/:617, durable fallback `g_macro_expansions` :2553-2561), consulted at ~18 files / 132 refs — **not all macro-only**: `src/evaluator/calls/pointer_type.yo:135-179` and `numeric_type.yo:431-461` reuse `record_macro_expansion` as a generic lowering channel (see C3) |

### 1.2 The nine live std macros

| Macro | Definition | Callers | Fate |
| ----- | ---------- | ------- | ---- |
| `for` | `std/prelude.yo:10644` | 0 src, 0 std, 190 in tests/ | desugar (B1) |
| `for_await` | `std/async/stream.yo:446` | tests only | desugar (B2) |
| `(^)` | `std/prelude.yo:10075-10131` | 0 src, 0 std; the Iso test files (A6) | deleted with Iso (A1) |
| `Var.is_owning_the_rc_value` / `Var.has_other_aliases` | `std/prelude.yo:8239-8248` | 2, inside `(^)` itself | deleted with Iso (A1) |
| `unsafe.drop` | `std/prelude.yo:247` | 12, all std — 11 after A1 (one sits inside `(^)`'s quoted body) | plain fn or desugar (B4) |
| `array_list` | `std/collections/array_list.yo:1848` | 8 in `src/parser.yo` (:1235, :1585, :1586, :1603, :1754, :1783, :1824, :1915), 47 in tests | desugar (B3) |
| `hash_map` | `std/collections/hash_map.yo:1514` | tests only | desugar (B3) |
| `hash_set` | `std/collections/hash_set.yo:473` | tests only | desugar (B3) |

Gated user-macro fixtures (deleted or rewritten in C5): `tests/macro_def_pragma.test.yo`,
`tests/macro_def_gate.test.yo`, `tests/internal/macro_expansion.test.yo`,
`tests/internal/macro_registry.test.yo`, parts of `tests/internal/ast_reflection.test.yo`
and `tests/internal/macro_helpers.test.yo`, `tests/codegen-bootstrap/try_macro_assign.yo`,
and the local `_recv_one` macro at `tests/async/channel.test.yo:417`.

### 1.3 Iso machinery (deleted in Part A)

- **Evaluator**: `src/evaluator/calls/iso.yo` (585 lines — `evaluate_iso_type_call`
  :185 with the Phase H/D2/D9 gates, `evaluate_iso_value_call` :413);
  dispatch arms at `src/evaluator/exprs/_expr.yo:1154` and
  `src/evaluator/calls/function.yo:8647`; `__yo_iso_extract` / `__yo_iso_unique`
  evaluators at `src/evaluator/builtins/rc_fns.yo:247-320`; `IsoValueResult` in
  `src/evaluator/context.yo:654`; the `Arc(Iso)` ban at
  `src/evaluator/types/struct.yo:234-259`; trait arms at
  `src/evaluator/trait_checking.yo:360, 402, 770`; synthesizer arms
  (`src/evaluator/types/synthesizer.yo` :514, :1585); the `Rc(.IsoT(...))` arm
  and `TypeInfo.Iso` serialization at `src/evaluator/builtins/type_fns.yo:1225-1227`;
  `src/evaluator/builtins/var_fns.yo` (158 lines — the
  `__yo_var_is_owning_the_rc_value` / `__yo_var_has_other_aliases` evaluators,
  whose sole consumers are the two `Var.*` macros); misc arms
  `property_access.yo:1385`, `begin.yo:3250` (`frame_is_isolating`),
  `utils.yo:2957`, `types/function.yo:5257`, `calls/helper.yo:555`,
  `effects/mutation_summary.yo:851`; the "wrap it in Arc/Iso" error text at
  `src/evaluator/utils/closure.yo:851`.
- **Types**: the `TypeValueNode.IsoT` variant (`src/types/definitions.yo:345`) —
  the enum is closed, so its match arms go in `creators.yo` (:172, :314 `t_iso`,
  :616), `tags.yo` (:67, :121 `TIso`), `guards.yo` (:499 `is_iso_type`; KEEP
  `is_atomically_counted_rc_type` :508 — `Arc` and `atomic(ref(...))` keep the
  function, minus its `is_iso_type` disjunct),
  `string.yo:368`, `compatibility.yo:1451-1453`, `substitution.yo:732`,
  `intern.yo:235`, `hierarchy.yo:13`, `utils.yo:1170, 1953, 2113`;
  `type_reaches_non_atomic_cell` (`src/types/utils.yo:1241`) dies if
  `Type.contains_rc_type` reflection does not share it — check before deleting.
- **Codegen**: `src/codegen/exprs/iso.yo` (132 lines); the `IsoTypeInfo`
  registry in `src/codegen/utils/index.yo` (:129, :184-185, :676-697, the
  `.IsoT` arm of `get_type_string` :1746-1760); `generate_iso_*` in
  `src/codegen/types/generation.yo:1779-1830`; the deep-walk emission
  `generate_iso_uniqueness_functions` (`src/codegen/functions/constructors.yo:876`);
  the `iso_types.len() > 0` trace-collection gate (`src/codegen/codegen_c.yo:520`);
  arms in `functions/declarations.yo:307-308, 546`,
  `exprs/other_fn_call.yo:256, 1470-1473`, `exprs/drop_dup.yo:41, 65, 120` and
  the `is_iso_type` arms :457/:704 (the atomic inc/dec arms `Arc` uses are the
  `is_atomic_reference_struct_type` / `is_atomic_reference_enum_type` arms at
  :445/:686 — those STAY),
  `exprs/async.yo:1052`, `functions/generation.yo:47, 1125-1126`,
  `types/collection.yo:245`, `exprs/rc_fns.yo:471`.
- **Env / optimizer**: `mark_function_frames_isolating` + `g_isolating_frame_ids`
  (`src/env.yo:5075-5090`) exists solely to keep refcounts truthful for the
  uniqueness walk (it disables the dup/drop move-optimizer inside `^v`-using
  functions) — delete it and its callers.
- **Front matter**: `BF_YO_ISO_EXTRACT/UNIQUE/DISPOSE` (`src/expr.yo:158-160`),
  `BK_ISO` (`src/expr.yo:379` + the :1053 export list), the LSP keyword
  (`src/lsp/completion.yo:132`), and the `Var` constants
  `BF_YO_VAR_IS_OWNING_RC` / `BF_YO_VAR_HAS_OTHER_ALIASES`
  (`src/expr.yo:280-281`) with their dispatch.
- **Prelude surface**: the SAFETY block and `impl(Iso(T), Send/Acyclic)`
  (`std/prelude.yo:10045-10059`), `extract` :10060-10069, the `(^)` macro
  :10075-10131, `TypeInfo.Iso` :8021, the `Isolation` trait :1051-1055 and
  `Rc`'s impl :9766-9771.
- **KEEP**: the atomic-RC runtime (`__yo_incr_rc_atomic` /
  `__yo_decr_rc_atomic`, `src/codegen/functions/gc_runtime.yo`) — `Arc` and
  `atomic(ref(...))` share it.

## Part A — remove `Iso(T)`, `^v`, `Var.*`, `Isolation`

No bootstrap gating: this is deletion only, and nothing outside the feature's
own surface references the deleted names (verified by the census above;
re-verify with a grep gate before landing).

- **A1 — prelude.** Delete the blocks in §1.3 "Prelude surface". The two open
  prelude slots (`(^)` in the operator set, `Var`) vanish; `Rc.try_unwrap`
  and `Arc.try_unwrap` are the documented replacement and already have tests
  (`tests/rc.test.yo`, `tests/arc.test.yo`).
- **A2 — evaluator.** Delete `src/evaluator/calls/iso.yo`, the dispatch arms,
  the `rc_fns.yo` evaluators, `IsoValueResult`, the `Arc(Iso)` ban, and the
  trait/misc arms listed in §1.3. `Send` derivation loses its one
  unconditional-by-uniqueness arm and becomes purely structural
  (VALUES_BY_DEFAULT §3.8).
- **A3 — types.** Remove `TypeValueNode.IsoT` and every match arm; delete
  `is_iso_type`, `t_iso`, `TIso`; resolve the `type_reaches_non_atomic_cell`
  question noted in §1.3.
- **A4 — codegen.** Delete the files, registry and arms in §1.3. The
  `iso_types.len() > 0` condition on trace collection goes; nothing else
  changes for `Arc`.
- **A5 — env / optimizer.** Delete `mark_function_frames_isolating`,
  `g_isolating_frame_ids`, and every call that keys on them. **This touches
  the dup/drop optimizer's family: the emit-diff gate plus an
  over-cancellation canary are REQUIRED** (AGENTS.md pitfalls; the move
  optimizer and the isolation frames interact).
- **A6 — tests.** Delete `tests/iso.test.yo`, `tests/iso_api_surface.test.yo`;
  remove the Iso sections from `tests/parallelism_soundness.test.yo`
  (D2/D9 blocks, the `^` canaries :644/:656/:670), `tests/thread_safety.test.yo`
  (:251-259 ban pins), `tests/send_sync.test.yo` (:237, :280),
  `tests/basic.test.yo` (:533, :692), `tests/explicit_allocators.test.yo`
  (:66-77), `tests/rc.test.yo` (:129-142); trim the `IsoT` cases from
  `tests/internal/types_type_guards.test.yo`, `types_guards.test.yo`,
  `types_string_compat.test.yo`, `types_utils.test.yo`; regenerate the
  `tests/cli-cases/lsp-analysis-resilience` golden (`--record`; read the
  GOLDEN-DIFF first — the completion list loses the "Iso" keyword).
- **A7 — docs, plans, instructions.** Delete `docs/en-US/ISOLATED.md` and
  `docs/zh-CN/ISOLATED.md`; trim the Iso sections of THREAD_SAFETY, ARC,
  MEMORY_SAFETY, DESIGN ("Isolated Types"), PARALLELISM, EXPLICIT_ALLOCATORS,
  COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS, TYPE_REFLECTION in both languages.
  Revise `plans/VALUES_BY_DEFAULT.md` (:51, :614-616, :875, :4387, :4918-4926;
  replace the :695 line "`Iso(T)` / `^v` remain the explicit 'fail if shared'
  transfer" with the Rust-rule statement and a `Rc.try_unwrap` pointer),
  `plans/reference/PARALLELISM_RULES.md` (delete D2 :97-123 and the D9 section
  from :168; renumber the surviving rules and sweep every D2/D9 reference),
  `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` (the `(^) ::` sites :29,
  :56, :128, :131 and the "Iso sugar | `^`" table row :90), the ROADMAP's
  soundness pillar line, `plans/backlog/FUTURE_ORIGINS.md` (:19, :22, :123,
  :142-144, :155 — mark superseded), and moot follow-up 4 of
  `plans/TYPE_SYSTEM_SOUNDNESS.md` (:830). Update the D2 bullet and the
  `ref_count` note in `.github/instructions/yo-design.instructions.md`, the
  `Iso(T)(v)` constructor note in
  `.github/instructions/c-codegen.instructions.md` (:670), and the AGENTS.md
  architecture notes if they name Iso. Drop the keyword from the editor
  grammars: `vscode-extension/syntaxes/yo.tmLanguage.json` (:149) and
  `yo.vim` (:80).

**A — verification (Tier 1).** `yo build --std-path ./std`; `yo check ./src`
and `yo check ./std` (both `--std-path ./std`); the affected test files one
per invocation (iso deletions, parallelism_soundness, thread_safety, send_sync,
rc, arc, basic, explicit_allocators, the four internal types files);
`scripts/cli-diff-test.sh` for the LSP golden; the dup/drop emit-diff gate and
canary for A5; `yo fmt` (tree binary) on every touched `.yo`; `scripts/check-issue-refs.sh`.

## Part B — de-macro the remaining constructs (Generation A)

**Principle: each desugar emits exactly the AST the macro emits today.**
Acceptance gate per construct: the C emit-diff over the language corpus is
empty modulo ExprIds, and the construct's tests pass unchanged. Zero `.yo`
source migrates — call sites keep their spelling (`for(...)`,
`array_list(...)`, `unsafe.drop(...)` all still parse; the desugar rewrites
the call before name resolution, so the std names themselves stop mattering).

**The retained-macro rule** (the `if` → `cond` precedent, MACRO_POLICY "What
actually landed" item 3): the desugars land in the tree now, but the prelude
macros STAY until a desugar-bearing release is the seed — the seed compiles
`src/parser.yo`'s eight `array_list` sites and must keep expanding them. The
macros also remain the fallback for anything a desugar leaves alone (odd
arity, mismatched labels, dynamically built ASTs), so a missed path degrades
to today's behavior instead of breaking. Part C deletes them.

- **B1 — `for` → `desugar_for_calls`.** Add to the `desugar_if_calls` pass
  family in `src/expr.yo`, hooked at the same choke points (`parse()` in
  `src/parser.yo`, `Evaluator.new` in `src/evaluator/index.yo`, the derive
  result splice; the macro unquote-splice hook dies in Part C). The desugar
  runs AFTER the decision-42 `&mut` rewrite, on the same AST shape the macro
  receives, and reproduces every form the macro handles today:
  the value form (`coll.into_iter()`, collection moved into the iterator);
  the borrowed form `for(&mut coll, x => body)` (decision 39's cursor
  protocol — local borrow for the loop's whole extent, `BorrowedWalk` /
  `walk_elem`, `__borrow_guard` releasing on fall-through/`break`/`return`/
  `unwind`, E0911 for reaching `coll` by name, the hidden owning local for
  non-place sources via the `__for_source_is_place` structural check — port
  it from the `ExprVal` reflection the macro uses to the parser's structural
  walk); the map form `for(&mut map, (k, v) => body)`; and the deleted
  mode-word diagnostics (`mut(x)`/`inout(x)`/`imm(x)` naming the sigil
  spelling and the `borrow-spelling` migration). Hidden locals mint fresh
  ExprIds and synthesized unique names — the parser-side equivalent of the
  macro's `gensym`. `break`/`continue`/`return` keep working because the
  expansion is an ordinary `while` whose body is a block containing real
  `break` AST nodes (`BK_BREAK`, `src/expr.yo:357`) — exactly how the
  `for_await` macro's output works today. One semantic note, accepted with
  the decision: rewriting before name resolution means `for` can no longer
  be shadowed by a user function of that name — the same trade the `if` →
  `cond` desugar already made for `if`.
- **B2 — `for_await` → desugar.** The macro body (`std/async/stream.yo:446-471`)
  is the whole template — bind the stream to a fresh local, `while(true)`
  around `next` + `io.await`, `match` with `.Some(x) => body` and
  `.None => break`. The async transform already handles awaits inside macro
  expansions (single-pass lowering); after the desugar it sees a plain
  `while` + await, which REMOVES a macro-awareness requirement rather than
  adding one.
- **B3 — collection literals → desugar.** Rewrite `array_list(e0, e1, ...)`
  calls to the macro's expansion shape: bind the first element to a fresh
  local, `ArrayList(type_of(<first>)).new()`, then the pushes (the macro's
  `__array_list_build_pushes`). `hash_map` / `hash_set` analogously; their
  `k => v` arguments arrive as the same unevaluated AST the macro sees.
  Non-call uses of the names (none exist) are unaffected; the exported names
  stay until Part C.
- **B4 — `unsafe.drop`.** It is a pure rename of `___drop`
  (`std/prelude.yo:247`). First try a plain module-value export
  (`drop :: ___drop;` in the `unsafe` impl — the same shape as the existing
  `cast :: __yo_as;` at `:249`, which the seed already compiles) or a
  `fn(generic(T : Type), sink(value) : T) -> unit` wrapper — the 2026-08-21
  rejection of a plain fn predates the sink-parameter world; re-run it at the
  11 surviving std sites (the 12th dies with A1's `(^)` deletion). If a
  borrow edge surfaces, the fallback is a parse-time desugar to `___drop(v)`
  — but a desugar lives only in the tree's parser while std is compiled by
  the SEED, so the fallback must ship together with a retained plain `drop`
  binding (or the macro itself) until B5's release is the seed. The
  plain-binding route alone needs no generation discipline.
- **B5 — release cut.** Part A + Part B ship; when that release becomes the
  seed (`SEED_VERSION` bump), Part C unblocks.

**B — verification (Tier 1).** `yo build --std-path ./std`; both checks; the
construct's tests one per invocation (`tests/for_macro_borrow.test.yo`,
`for_macro_borrow_strict`, `for_macro_borrow_user_collection`, the async
stream/channel tests, the collections suites, `tests/rc.test.yo`,
`tests/arc.test.yo`); the emit-diff gate proving desugar ≡ macro output;
`yo fmt` with the tree binary. Full fast suite before merge (this touches
every `for` in 41 test files). Bootstrap gates (`gates_fast.sh`,
`fixpoint_only.sh`) since the parser and prelude both changed.

## Part C — delete the macro machinery (Generation B, after B5)

- **C1 — flip the gate to a removal error.** A signature with a quoted
  parameter or an unquote return becomes a hard error naming this doc and
  `plans/reference/MACRO_POLICY.md` (archive by then). No `yo fix` migration:
  the only in-tree definers are the fixtures C5 rewrites.
- **C2 — delete the machinery.** The §1.1 rows: registries + gate
  (`types/function.yo`), `is_macro_def_capable_file` + the std exemption
  (this RESOLVES the pending item at
  `plans/backlog/SEED_VERSION_AUTOMATION.md:51` — check it off there),
  `Pragma.AllowMacroDef` (variant, map line, AST-shape fast path), the
  dispatch (`MACRO_DISPATCH_ENABLED`, `fv_is_macro`, quoted-arg binding,
  force-execute flags, unquote-return splice), `macro_expand.yo`,
  `local_borrow_enter/leave_macro_site` and the `info.macro_site` diagnostic
  that keys on it (`src/evaluator/utils.yo:5727`, with whatever fills the
  field). `macro_expand`'s wiring goes with its file: the dispatch arm
  (`src/evaluator/exprs/_expr.yo:1239-1240`), `BF_MACRO_EXPAND`
  (`src/expr.yo:70` + the `:1057` export list), and the lexer fast path
  (`src/token.yo:143`). Delete the nine std macro
  definitions and their exports; the desugars own the call syntax now.
- **C3 — the lowering channel.** `pointer_type.yo:135-179` and
  `numeric_type.yo:431-461` reuse `record_macro_expansion` as a generic
  lowering channel. Convert both to an in-place AST rewrite — replace the
  call node's argument/callee and re-evaluate, the pattern the auto-deref
  hook already uses (`evaluate_property_access`'s `make_deref_expr` arm) —
  then delete `ExprInfo.macro_expansion`, `g_macro_expansions` and
  `record_macro_expansion`. If the in-place route hits node-identity or
  ExprInfo-keying invariants (the risk MACRO_POLICY §3.3 flagged), the
  fallback is keeping the table renamed as a builtin-lowering channel;
  record whichever lands in this doc. **The dup/drop emit-diff gate and an
  over-cancellation canary are REQUIRED either way** — `begin.yo`'s
  optimizer consults this table.
- **C4 — delete the dead chase sites.** The ~18 consumer files of §1.1's last
  row, minus what C3 kept. Same emit-diff gate.
- **C5 — tests, fixtures, docs.** Delete `tests/macro_def_pragma.test.yo`,
  `tests/macro_def_gate.test.yo`, `tests/internal/macro_expansion.test.yo`,
  `tests/internal/macro_registry.test.yo`,
  `tests/codegen-bootstrap/try_macro_assign.yo`; trim the gated-definition
  cases from `tests/internal/ast_reflection.test.yo` and
  `tests/internal/macro_helpers.test.yo` (KEEP the quote-value, `gensym` and
  `__yo_expr_*` reflection cases — that layer stays); rewrite
  `tests/async/channel.test.yo:417`'s `_recv_one` as plain code; trim the
  gate-path section of `tests/internal/memory_safety_paths.test.yo:62-86`;
  KEEP `tests/for_macro_borrow*.test.yo` (they pin `for` semantics, which the
  desugar preserves) and the formatter fixtures 33/34 (`unquote` inside
  `quote` stays legal). Rewrite the macro chapters of `docs/en-US/DESIGN.md`
  (:4546-4608) and `docs/zh-CN/DESIGN.md` (:4331-4407) as "no macro layer;
  comptime, builtin forms and quote/reflection are the extension mechanisms".
  Update the AGENTS.md "Macros kept but gated" bullet, the macro rules in
  `.github/instructions/yo-syntax.instructions.md` / `yo-design.instructions.md`,
  and the syntax cheatsheets. Close `LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3
  as rejected; note in `RUST_ADOPTION_CANDIDATES.md` L7 that `matches(x, p)`,
  if ever wanted, is a desugar/builtin — not a macro.
- **C6 — records.** Move the open macro S2 issue and the open nested-eval
  issue to `issues/retired/` with a line naming this doc (mooted by removal —
  they are not "fixed"). `git mv`
  `plans/reference/MACRO_POLICY.md` to `plans/archive/` with a supersession
  banner naming this doc; update `plans/README.md` and every
  `grep -rn "MACRO_POLICY"` reference.
- **C — escape-hatch checklist** (a parse-surface change outside `src/`/`std/`):
  grep `.github/workflows/` for `AllowMacroDef` and quoted-param signatures
  (the census found none — re-verify), run `scripts/check-embedded-yo.sh`,
  and put the tree binary first on `PATH` for tests embedding Yo source in
  string literals.

**C — verification.** Full Tier 1; the fast suite; `yo test ./std`;
`tests/internal` one file per invocation for the rewritten files;
`scripts/bootstrap/hollow_sweep69.sh` (every language test through the
self-hosted binary — this is the widest parse-surface sweep available);
`fixpoint_only.sh`; fmt and `check-issue-refs.sh`.

## Execution order

A (one PR, or A1-A5 + A6/A7 split) → B1 → B2 → B3 → B4 (one PR each; B1 is
the only large one) → **release cut** (B5) → C1+C2 → C3 → C4-C6. Heavy steps
(`yo build`, `tests/internal`, the sweeps) take a machine-wide heavy-lock
slot. Every PR follows `.github/pull_request_template.md` and merges on its
Tier 1; develop's battery covers the rest.
