# Macro Policy — keep, gate, and shrink the expansion tax

**Status:** IMPLEMENTED 2026-08-21 (single PR: the `AllowMacroDef` gate, the
`if`→`cond` parse-time desugar, and the `try` removal — see "What actually
landed" at the bottom for the deltas versus the original proposal)

## Problem

Macros add real language and compiler complexity, and the question was raised
whether Yo should keep them at all, given that Yo also has a strong comptime
system. This document records the audit that answered that question (2026-08-21),
the decision, and the implementation plan.

**Decision: keep macros, but (1) gate macro *definitions* behind a pragma the
same way unsafe is gated, (2) de-macro the trivial forwarder macros, and
(3) separately remove the real maintenance pain — the `ExprInfo.macro_expansion`
side-table chase — starting with `if`.**

---

## Part 1 — Audit findings (the basis for the decision)

### 1.1 What a macro is in Yo

There is no `macro` keyword and no parser/lexer support beyond the 5-line
`...#` token (`src/lexer.yo:107-111`). A macro is an ordinary comptime function
whose *type signature* carries one or both of two flags:

- a **quoted parameter** — `quote(p) : Expr` — binds the caller's raw AST as an
  `ExprVal` instead of evaluating it;
- an **unquote return** — `-> unquote(Expr)` — splices the returned Expr into
  the call site, re-evaluated in the caller's environment.

Detection is a func-id-keyed side registry, not a type property
(`src/evaluator/types/function.yo:126-135`, registries at `:77-185`,
registration at `:4288-4297`). Macro calls run on the **same CTFE engine** as
every comptime function (`evaluate_comptime_fn_call`); the deltas are three
narrow hooks in `src/evaluator/calls/function.yo`: quoted-arg binding
(`:4346-4371`), the force-execute context-flag dance (`:5492-5497`), and the
unquote-return splice + expansion recording (`:5519-5548`).

Consequence: "macros vs comptime" is not two systems. It is one system with
two extra signature flags, so "deleting macros" means deleting exactly those
two flags and the macro-call dispatch — nothing else.

### 1.2 Complete macro inventory (10 live, 0 in src/, 0 in user code)

| # | Macro | Location | Why it needs macro powers | Call-site pressure |
|---|-------|----------|---------------------------|--------------------|
| 1 | `if` | `std/prelude.yo:7649-7669` | lazy branches (expands to `cond`) | **6262 in src/, 236 in std/**, 156 in tests/ |
| 2 | `try` | `std/prelude.yo:7670-7689` | early `return(.Err(e))` in the **caller's** frame | 0 in src//std/, 11 in tests/ |
| 3 | `for` | `std/prelude.yo:7690-7785` | destructures the `(x) => body` lambda as AST; caller-frame `break`/`continue` | 1 in src/ (`suspension_analysis.yo:454`), 82 in tests/ |
| 4 | `(^)` iso sugar | `std/prelude.yo:7448-7500` | needs the caller's **variable identity** (`Var.*` intrinsics), not its value | 3, all in tests/ |
| 5 | `unsafe.drop` | `std/prelude.yo:175` | none — 1-line forwarder to `___drop` | 37, all in std/ |
| 6 | `Var.print_info` | `std/prelude.yo:6311-6318` | none — forwarder to `__yo_var_print_info` | **0 anywhere** |
| 7 | `Var.is_owning_the_rc_value` | `std/prelude.yo:6320-6324` | none — forwarder | 2 (inside `^`) |
| 8 | `Var.has_other_aliases` | `std/prelude.yo:6325-6329` | none — forwarder | 1 (inside `^`) |
| 9 | `array_list` | `std/collections/array_list.yo:859-876` | variadic unevaluated args + `typeof` on unevaluated first element + statement splicing | 5, all in `src/parser.yo` |
| 10 | `hash_map` / `hash_set` | `std/collections/hash_map.yo:824-848`, `hash_set.yo:853-869` | same, and `hash_map` must destructure `k => v` as AST (not a valid expression) | 0 in src//std/, 3 each in tests/ |

Dead precedent worth knowing: `Array.fill` was a macro, is commented out with
"NOTE: Macro doesn't work yet", and was **replaced by a comptime function**
directly below it (`std/prelude.yo:5598-5615`) — a worked macro→comptime
conversion.

### 1.3 `derive` and `iso` are NOT on the macro path

- **`derive` is not a macro.** Every derive rule (`__derive_eq` at
  `std/prelude.yo:6600`, `__derive_clone` `:6711`, `__derive_hash` `:6808`,
  `__derive_ord` `:6973`, `__derive_tostring` `std/fmt/to_string.yo:285`) is a
  plain comptime fn `fn(comptime(T) : Type, comptime(ctx) : DeriveContext,
  comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)` — no quoted
  param, no unquote return, so `is_macro_fn` is false and macro dispatch never
  fires. The `derive`/`derive_rule` **builtins** (`src/evaluator/builtins/derive.yo`,
  `derive_rule.yo`) explicitly evaluate the returned Expr.
  `plans/reference/DERIVE_TRAITS.md:147` states this design explicitly.
- **But derive hard-depends on the quote/Expr comptime layer**: `quote`,
  `unquote`, `#()`, `...#()`, `gensym`, `Expr`/`ExprList`, `EvalValue.ExprVal`,
  `clone_expr_fresh_ids`, the `__yo_expr_*` reflection builtins, and
  `DeriveContext.make_impl` (`std/prelude.yo:6537-6565`). **That layer survives
  any macro decision.** `quote` and all AST/type reflection builtins are
  dispatched ungated from `src/evaluator/exprs/_expr.yo:905-924` and are fully
  usable outside macros (e.g. `tests/comptime.test.yo:2959-2976`).
- **`iso` is a builtin** (`src/evaluator/calls/iso.yo`, `__yo_iso_extract` /
  `__yo_iso_dispose`). Only the ergonomic `^(x)` wrapper is a macro. Deleting
  macros would kill `^` but leave `Iso(T)` fully usable.

### 1.4 What macros actually cost

**LOC:** ~1,500–1,900 macro-only lines in `src/` (`macro_expand.yo` 293,
`gensym.yo` 159, `expr_fns.yo` 658, registries ~110, signature validation ~205,
dispatch ~170, codegen consultation ~170, misc) plus ~1,200 lines of tests.
`builtins/quote.yo` (313) is NOT in this number — derive keeps it.

**The real cost is structural, not LOC.** A macro call keeps its macro head in
the AST forever; codegen and every analysis pass can only see the lowering via
`ExprInfo.macro_expansion` plus the durable fallback table `g_macro_expansions`
(`src/expr_info.yo:425-426, 1332-1354`). That obligation is replicated, by
hand, at ~30 sites across 11 files:

- `src/codegen/exprs/generation.yo:579-595` (main dispatch)
- `src/codegen/types/collection.yo:558-567`
- `src/codegen/functions/collection.yo:137, 544-557` (+ macro suppression `:304-324`)
- `src/codegen/functions/declarations.yo:381-400`
- `src/codegen/async/state_code_gen.yo:110-115, 517-521, 593-598, 877, 910, 936, 1075-1140, 1183, 1427-1434`
- `src/codegen/async/state_machine.yo:1452-1458`
- `src/codegen/shared/suspension_codegen.yo:58-65`
- `src/expr_traversal.yo:295-304, 376-392`
- `src/evaluator/exprs/begin.yo:213-263, 785, 830-846, 878-908` (dup/drop optimizer)
- `src/evaluator/shared/suspension_analysis.yo:368-381`
- `src/evaluator/effects/mutation_summary.yo:13-14, 305-307`

Nothing enforces this; the failure mode is silent. The bill so far:

- `issues/fixed/yo-self-recur-codegen-macro-expansion.md` — lost expansions
  across eval passes → **275** "Failed to transpile" markers; fix required
  inventing the durable side table.
- `issues/fixed/yo-self-failed-transpile-if-in-match-arm.md` — the same bug in
  a third walker → **315** clang errors.
- `issues/fixed/yo-self-macro-dispatch-corruption.md` — macro dispatch
  intermittently corrupted the heap; `MACRO_DISPATCH_ENABLED` stayed `false`
  in committed builds for months (`src/evaluator/calls/function.yo:118`).
- `issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`
  — **still open**: nested eval inside a macro/derive-generated body corrupts
  the enclosing module evaluation.
- `issues/fixed/recur-short-circuit-inside-macro-body.md`,
  `issues/fixed/yo-self-expr-eq-macro-body-false.md` — context-flag leakage
  into macro bodies.
- `issues/fixed/await-in-branch-positions-matrix.md` +
  `src/codegen/async/state_code_gen.yo:910-940` — the async state machine
  cannot place `await` in several `if` positions; the error message tells the
  user to rewrite as `cond`. **This user-visible limitation exists only
  because `if` is a macro.**
- Macros are exempt from the CTFE overload-trial skip gate
  (`src/evaluator/calls/comptime_fn.yo:582`), so macro bodies execute during
  every overload trial.
- Macro expansions bypass the unsafe pragma gate via the `auto-generated://`
  carve-out (`src/evaluator/memory_safety.yo:97-117`,
  `plans/reference/MEMORY_SAFETY.md:395`) — deliberate ("the macro author owns the
  contract"), but a real privilege edge.
- Macros are **unhygienic**: expansion evaluates in the caller's env; `gensym`
  is the entire (manual) hygiene story. Survivable mainly because Yo forbids
  shadowing, so accidental capture tends to surface as a redeclaration error.

Counterpoint: the macro implementation files themselves are stable (one commit
to `macro_expand.yo`/`quote.yo` in all of 2026). The churn and the bugs are in
the ~30 *consumers* forced to see through macro heads.

### 1.5 Why not delete

- The quote/Expr/reflection layer survives regardless (derive needs it), so
  deletion removes only the two signature flags + dispatch — while forcing
  `if`, `for`, `try`, `^`, and three collection literals to be reimplemented
  as evaluator+codegen builtins. Much of the "deleted" complexity returns in a
  different (closed) form.
- The four irreducible macro-only powers — auto-splice at the call site,
  introducing bindings into caller scope, caller-frame control flow
  (`try`'s early return), and reifying a caller lvalue's identity (`Var.*`,
  `^`) — are exactly what comptime functions cannot express. `try` alone
  justifies the mechanism unless Yo grows a dedicated `?`-like feature.
- Zig proves comptime-only is coherent, but Zig pays with builtin `if`/`for`
  *syntax*. Yo's function-call-for-everything surface has to get those forms
  from somewhere; today that is macros.
- The docs already contradict each other — `docs/en-US/DESIGN.md:2960-3010`
  advertises macros (top-level TOC entry, an `unless` example that exists
  nowhere), while `docs/en-US/INLINE_ASSEMBLY.md:1090` claims "Yo has no macro
  system". Part 4 fixes this either way.

---

## Part 2 — Gate macro definitions: `Pragma.AllowMacroDef`

Mirror the unsafe gate exactly, but gate the **definition**, not the call.
Calling prelude macros (`if`, `for`, `try`, literals) stays free everywhere;
*defining* a macro (a fn type with a quoted param or unquote return) requires
the file to declare the pragma.

Rationale: like `unsafe`, a macro definition is a power tool with non-local
effects (unhygienic caller-env splicing, the `auto-generated://` privilege
inheritance, per-trial CTFE execution). Requiring an explicit per-file opt-in
keeps the default dialect small and makes macro definitions greppable.

### Mechanics (the unsafe precedent, ~120 lines total)

1. **`Pragma` enum** — add `AllowMacroDef` at `std/prelude.yo:48-74`.
2. **`pragma` builtin** — one mapping line in
   `src/evaluator/builtins/pragma.yo` (`pragma_kind_from_variant_name`).
3. **Helper** — `is_macro_def_capable_file(module_path)` next to
   `is_implicitly_unsafe_capable_file` (`src/evaluator/memory_safety.yo:97-106`),
   with the same `auto-generated://` carve-out (macro/derive-generated code
   inherits the defining caller's privilege — already the established policy).
4. **One gate** — in `src/evaluator/types/function.yo:4288-4297`, where
   `register_macro_quoted_params` / `register_macro_return_is_unquote` fire.
   If the defining file lacks the pragma, throw a compile error on the fn-type
   token: something like
   `"Macro definitions (quote parameters / unquote return types) require pragma(Pragma.AllowMacroDef); at the top of the file"`.
5. **std opts itself in** — `std/prelude.yo` already self-pragmas
   `AllowUnsafe` at `:79-80`; add `pragma(Pragma.AllowMacroDef);` beside it.
   Also needed in `std/collections/array_list.yo`, `hash_map.yo`,
   `hash_set.yo` (their literal macros) — nothing else in std/ defines macros.
6. **Tests** — the five macro-defining internal test files
   (`tests/internal/quote_macro_eval.test.yo`, `macro_expansion.test.yo`,
   `ast_reflection.test.yo`, `macro_helpers.test.yo`, `macro_registry.test.yo`)
   add the pragma; plus a new negative test: defining a macro *without* the
   pragma is a compile error, and passing an explicit `quote(...)` value to a
   `comptime(e) : Expr` parameter still works *without* the pragma (the gate
   must not catch derive-style comptime AST work).

```rust
// New: gated macro definition
pragma(Pragma.AllowMacroDef);

unless :: (fn(quote(c) : Expr, quote(body) : Expr) -> unquote(Expr))(
  quote(cond(unquote(c) => (), true => unquote(body)))
);
```

Naming: `AllowMacroDef` (verb-object-noun, matching `AllowUnsafe`);
`AllowDefMacro` was the original suggestion — pick one at implementation time,
it is one identifier.

**Non-goal:** gating `quote`/`gensym`/`__yo_expr_*`/reflection. Those are the
comptime AST layer, shared with derive, and remain ungated.

## Part 3 — Shrink the macro surface and the expansion tax

### 3.1 Shrink the macro surface

**REVISED at implementation time (2026-08-21).** The audit's "trivially
replaceable forwarder" verdicts were WRONG for `unsafe.drop` and the
`Var.*` wrappers: each one exists precisely to reify the CALLER's lvalue
(`___drop(x)` / `__yo_var_*(x)` must see the caller's binding, and a plain
fn parameter is a different binding with different ownership/alias state).
An `own`-param fn for `drop` was considered and rejected — moving field
projections out through a parameter changes borrow behavior at 37 std call
sites. These four stay as macros; they are one-liners, std-exempt from the
gate, and correct as written.

What shrank instead: **the std `try` macro was REMOVED** (user decision,
2026-08-21). It had zero call sites in src//std/ (only its own test file),
it was the one std macro that injected a hidden caller-frame `return`, and
its name collided conceptually with the algebraic-effects system. Anyone
who wants it can define it locally in three lines under
`pragma(Pragma.AllowMacroDef);` — `tests/codegen-bootstrap/try_macro_assign.yo`
keeps a working copy (which doubles as corpus coverage of a gated user
macro), and `tests/macro_def_pragma.test.yo` re-creates it to preserve
coverage of caller-frame early return through the macro machinery.

The live std macro set is now 9: `if` (spec/fallback only — see 3.2),
`for`, `^`, `unsafe.drop`, the three `Var.*` introspectors, and the three
collection literals.

### 3.2 Promote `if` off the macro path (the high-leverage move)

`if` is 99% of all macro call sites (6262 in src/, 236 in std/) and the direct
cause of the two biggest incident classes (lost-expansion transpile failures;
the async `await`-in-`if` position matrix). Rewrite `if(c, t, e)` →
`cond(c => t, true => e)` **eagerly at a single choke point** (parse-time
desugar, or evaluator pre-dispatch — decide during implementation; parse-time
is simpler but must preserve `yo fmt` round-tripping and error spans), so the
macro head never reaches the analysis passes.

Payoff:

- Most of the ~30 `macro_expansion`-chasing sites become dead weight for `if`
  (they stay for the remaining 6 macros, but the blast radius of forgetting
  one drops from "every `if` in the tree" to "user macros + try/for/literals").
- Structurally fixes the `await`-in-`if` async limitation
  (`issues/fixed/await-in-branch-positions-matrix.md`) — the state machine would see
  real `cond` branch structure.
- Removes 6k+ macro dispatches (and their per-overload-trial CTFE executions)
  from every compile.

Care points:

- The labeled form `if(c, then: {...}, else: {...})` currently relies on a
  label-strip hack in quoted-arg binding
  (`src/evaluator/calls/function.yo:4340-4372`); the desugar must handle
  labels natively.
- The default-else (`(quote(else) : Expr) ?= quote(())`) becomes `true => ()`.
- Two non-macro features reuse `record_macro_expansion` as a generic lowering
  channel (`src/evaluator/calls/pointer_type.yo:135-179`,
  `src/evaluator/calls/numeric_type.yo:431-461`) — the side table stays; do
  not delete it when `if` stops feeding it.
- `yo fmt` must keep printing user-written `if` as `if`.

`for`/`try` can follow the same route later if they ever hurt; they are not
worth it today (1 and 0 non-test call sites in src//std/ respectively — though
tests/ uses both heavily).

### 3.3 Backlog (not this campaign)

- **In-place expansion** as the root-cause alternative: substitute the
  expansion into the AST instead of side-tabling it (the TS compiler never
  lost expansions because ExprInfo lived on the node; the durable table is a
  port artifact). Touches node-identity/ExprInfo-keying invariants — bigger
  and riskier; only worth it if the remaining macro set grows.
- Root-cause the open nested-eval corruption
  (`issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`)
  — likely falls out of `plans/backlog/YO_SELF_ENV_SHARING.md`.

## Part 4 — Documentation

- Resolve the contradiction: `docs/en-US/INLINE_ASSEMBLY.md:31, 1090` ("Yo has
  no macro system") vs `docs/en-US/DESIGN.md:2960-3010` (the macro chapter).
  The truth after this plan: "Yo has a small, pragma-gated macro layer on top
  of comptime; builtins and comptime are the primary extension mechanisms."
- Fix stale `derive_rule` signatures still showing the obsolete macro form
  (`docs/en-US/DESIGN.md:3037-3060`, `docs/en-US/TYPE_REFLECTION.md:310`) —
  the real signature is all-comptime (`docs/en-US/DERIVE_TRAITS.md:125-135`).
- Document `Pragma.AllowMacroDef` in the macro chapter and wherever `Pragma`
  variants are listed; if 3.2 lands, update `DESIGN.md:1253-1275` ("The `if`
  in Yo is actually a macro function").
- Both languages: `docs/en-US/` and `docs/zh-CN/`.
- Update `.github/instructions/yo-syntax.instructions.md` /
  `yo-design.instructions.md` and the syntax cheatsheets with the pragma rule.

## Execution order & verification

Each step is independently landable, in this order:

1. **Forwarder de-macroing (3.1)** — verify: `yo check ./src`, `yo check ./std`,
   `tests/iso.test.yo`, `tests/rc.test.yo`, plus the std collections suites
   that call `unsafe.drop` internally.
2. **`Pragma.AllowMacroDef` gate (Part 2)** — verify: new negative test fails
   before the pragma is added and passes after; all five macro-defining
   internal test files updated; `tests/derive.test.yo` (user derive rules)
   passes **without** any pragma; full fast suite
   (`yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`).
3. **`if` promotion (3.2)** — the big one; own PR. Verify: full fast suite,
   `tests/internal` one file at a time, fmt round-trip on the whole tree
   (`yo fmt --check`), bootstrap gates (`gates_fast.sh`, `fixpoint_only.sh`),
   and `tests/async_await.test.yo` re-run. (Note, learned at
   implementation time: the await-in-`if` cells in
   `issues/fixed/await-in-branch-positions-matrix.md` were already fixed
   2026-08-10; the two remaining rejections are deliberate `cond`-level
   semantics the desugar does not change. The desugar's async win is
   structural — the state machine no longer depends on the
   `macro_expansion` side-table for `if` — not new matrix cells.)
4. **Docs sweep (Part 4)** — with or after each of the above.

Steps 1–2 are low-risk and can proceed immediately; step 3 needs its own
design pass on the desugar point (parser vs evaluator) before implementation.

---

## What actually landed (2026-08-21, one PR)

All parts landed together at the user's direction. Deltas vs the proposal:

1. **Gate (Part 2) — landed as designed**, with two implementation facts
   the proposal missed:
   - `pragma(Pragma.AllowMacroDef)` is recognized **by AST shape** in
     `evaluate_pragma`'s fast path (like `SkipPrelude`) and registered from
     there, because `SkipPrelude` snippet files (the internal evaluator
     tests) cannot resolve `Pragma` by evaluation.
   - The std exemption matches module paths in BOTH forms the loaders
     produce — raw (`./std/prelude.yo`) and `file://` URIs — against a
     trailing-slash-normalized `ctx.std_path`. **It is bootstrap-
     transitional**: the seed binary's pragma handler predates the
     variant, so std files cannot carry the pragma call until a release
     containing this PR becomes the seed; then std self-declares and the
     exemption branch is deleted.
   - The gate sits immediately before `register_macro_quoted_params` /
     `register_macro_return_is_unquote` in
     `src/evaluator/types/function.yo` and fires on
     `quoted_param_indices.len() > 0 || is_return_unquote`.
2. **Forwarder de-macroing (old 3.1) — dropped as wrong** (see the revised
   3.1); **`try` removal landed instead**.
3. **`if` promotion (3.2) — landed as a parse-time desugar**
   (`desugar_if_calls` / `desugar_program_if_calls` in `src/expr.yo`):
   - Hooked at `parse()` (parser.yo — covers module loads, compile
     entries, the test runner; the formatter works on tokens and never
     sees it), `Evaluator.new` (evaluator/index.yo), the macro
     unquote-return splice (evaluator/calls/function.yo), and the derive
     result splice (evaluator/builtins/derive.yo).
   - `quote(...)` subtrees are SKIPPED (quoted ASTs are user-visible
     comptime values); spliced code is desugared at the splice hooks.
   - Labeled `if(c, then : t, else : e)` unwraps matching labels; a
     mismatched label bails out of the rewrite.
   - The rewritten `cond` node keeps the original call's ExprId; inner
     synthesized nodes mint fresh ids.
   - **The prelude `if` macro is RETAINED**, for two reasons: the seed
     binary has no desugar pass and needs it to compile this tree at all,
     and it is the fallback for anything the desugar leaves alone (odd
     arity, mismatched labels, dynamically built ASTs) — the failure mode
     of a missed path is the previous behavior, never breakage. Delete it
     only after a desugar-bearing release becomes the seed.
4. **Docs (Part 4) — landed**: DESIGN.md (if-desugar prose, gated macro
   section, `try` removal note, fixed stale `derive_rule` signature),
   TYPE_REFLECTION.md (stale signature), INLINE_ASSEMBLY.md ("no macro
   system" contradiction), all in en-US and zh-CN, plus
   yo-syntax.instructions.md and the syntax cheatsheet.
5. **Tests**: `tests/macro_def_pragma.test.yo` (gated definitions: lazy
   args + caller-frame early return), `tests/macro_def_gate.test.yo`
   (ungated definition is a compile error; quote/Expr values stay
   ungated), `tests/try_macro.test.yo` deleted,
   `tests/codegen-bootstrap/try_macro_assign.yo` rewritten with a local
   gated macro, `pragma(Pragma.AllowMacroDef);` added to the 8
   macro-defining snippets across the internal macro test files.

## Open questions (considered, deferred)

- **Drop the `#` / `...#` aliases for `unquote` / `unquote_splicing`?**
  Raised 2026-08-21; deferred. Two spellings for one operation is a real
  design smell, but the terse forms are what keep derive templates
  readable (`quote(self.(#(f.name.to_expr())))...`), splices only occur
  inside `quote` where they are unambiguous, and removal is pure churn
  across every `__derive_*` rule, both doc languages, the formatter's
  tight-syntax rules, and the lexer. If it is ever done: remove the
  aliases, keep the spelled-out forms, as a mechanical follow-up PR.
- **When a desugar-bearing release becomes the seed**: delete the prelude
  `if` macro + its `export`, add `pragma(Pragma.AllowMacroDef);` to
  std/prelude.yo and the three collection modules, and drop the std
  exemption branch from `is_macro_def_capable_file`.
