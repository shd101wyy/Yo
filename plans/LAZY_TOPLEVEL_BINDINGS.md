# Lazy top-level bindings — order-independent `::` definitions and `impl` registration

**Status: P0–P4 LANDED 2026-09-05** (P0–P2 + P4: PR #427 `feat/lazy-toplevel-bindings`;
P3, retiring the impl-block forward shells: PR `feat/retire-impl-forward-shells`,
§10 "P3 as landed"); P5 (seed bump, lift the `std/`/`src/` rule) remains.
Written 2026-09-02 after the D5/§5 closeout hit the rule the hard way:
`std/fs/file.yo`'s free `read_to_string` called the `Reader` default on a `File`
while `impl(File, IoTraits.Reader(...))` sat 250 lines LATER — the call failed
definition-time evaluation, the failure was swallowed, `yo check ./std` stayed
green, and only the C22 stub gate rejected the hollow closure at C-compile time.
This plan removed the rule instead of documenting it again.

**What landed (see §10 for the adjustments against the 2026-09-02 design):**
`::` definitions and `impl(...)` registrations are order-independent within a
module file; forcing happens ONLY on a lookup miss (identifier, `export`,
method/trait lookup on a named type), so order-correct programs evaluate in the
same order and emit byte-identical C; function definitions publish a phase-A
FuncVal before their body trial, which makes bare-name self-recursion and mutual
recursion work; cycles between constants/types error with the chain; a forced
definition's own error is reported with a note saying why it ran early.
User docs: `docs/en-US/DEFINITION_ORDER.md` (+ zh-CN).

Supersedes the scope note in `docs/en-US/IMPL_FORWARD_REFERENCES.md` ("Top-level
`name :: value` definitions — no forward references yet"; "cross-impl-block
forward references — merge them into one block"). Companion records:
`issues/fixed/def-eval-swallow-remaining-roots.md` (the shell attempt that
regressed, §"ATTEMPT 2026-08-13"), `issues/fixed/forward-ref-shell-orphan-
duplicate-emission.md`, `issues/fixed/forward-fn-ref-in-toplevel-holder.md`,
`plans/backlog/YO_SELF_ENV_SHARING.md` (why envs are shared, not copied).

---

## 1. Problem

A module body is evaluated strictly top-to-bottom in one env frame
(`evaluate_anonymous_module_begin_exprs`, `src/evaluator/values/anonymous_module.yo`),
and every function body is evaluated AT DEFINITION TIME (`_trial_eval_fn_body`,
`src/evaluator/calls/function_type.yo` — type check + CTFE + ExprInfo stamping).
A body naming a binding that appears later in the file therefore fails with
`Variable "X" not found` / `No matching call found`. Two consequences:

1. **The language rule.** Callee before caller, impl before consumer, exports
   last (`.github/skills/yo-syntax/syntax-cheatsheet.md` §"Forward references are
   NOT allowed"). Mutual recursion between free functions needs holder
   variables; `impl` blocks must be textually ordered against their users.
2. **The silent failure.** The def-time trial SWALLOWS the error (the handler is
   a capture-free `->`; only flow-violation-flagged errors re-raise, see the
   C18/C19 fixes). The enclosing `io.async` body is emitted as a hollow stub.
   `yo check` is green; the C22 gate (`__attribute__((error))` on value-
   returning stubs) is the only thing that catches a SURVIVING call, and a
   dead one is never caught at all.

Three partial mechanisms existed and each was a symptom of the missing feature:
the same-`impl`-block forward-shell pre-pass (`_try_create_forward_shell`,
`src/evaluator/values/impl.yo:2598`, Case 3 only, canonical method shape only,
bailed when the signature head could not be evaluated — RETIRED in P3),
`_build_forward_ref_funcval` for recursive calls mid-specialization
(`calls/helper.yo:1689`), and `recur`.

## 2. Goal and non-goals

**Goal.** Within one module, `name :: <definition>` bindings and `impl(...)`
registrations are **order-independent**: a definition may reference any other
definition of the same module regardless of source position, including mutual
recursion between free functions and between methods of different `impl`
blocks. Errors that today are swallowed into hollow stubs become real
diagnostics at the definition site.

**Non-goals.**
- Reordering *statements*: `pragma(...)`, `open(import(...))`, `import`
  bindings, module-level mutable globals `(g : T) = v`, `comptime_assert`,
  `export(...)`, and bare expression statements keep strict source order.
  Their EFFECTS are the module's observable evaluation; hoisting them would
  change semantics. (This is Zig's model too: declarations are
  order-independent, `usingnamespace`/side effects are not.)
- Cross-module laziness: a module is still fully evaluated before its value is
  handed to an importer (`register_module`, `src/evaluator/module_loader.yo`);
  import cycles keep today's in-progress-module behaviour.
- Runtime semantics: nothing changes in emitted C for programs that are
  order-correct today (see §6, the byte-identity acceptance test).

## 3. Semantics (the contract to document)

1. A **compile-time binding** whose right-hand side is a **definition** — a
   `fn(...)`/`ctl(...)`/`unsafe_fn(...)` literal applied to a body, a
   `struct`/`enum`/`ref(...)`/`trait`/type-constructor expression, a macro
   definition, or a comptime constant expression — is **deferred**: it is
   bound in the module env as a *pending* binding at its source position and
   evaluated on first reference, or at module end, whichever comes first.
   "Compile-time binding" is the evaluator's notion, NOT the `::` token: the
   spellings `x :: v`, `comptime(x) := v`, `(comptime(x) : T) = v` and
   `comptime(x) : T; x = v` are one class (`docs/en-US/DESIGN.md` "Variables";
   `initialization_assignment.yo` folds them into `effective_is_compile_time_only`,
   with the LHS `comptime(...)` modifier being `BK_COMPTIME`, `src/expr.yo:232`).
   The deferral keys on that flag. A `:=`/`=` binding without the modifier is a
   runtime variable and stays an ordered statement (rule 6/7).
2. An `impl(<receiver>, ...)` statement is **deferred per receiver**: it is
   indexed under its receiver's syntactic head (the atom `File` in
   `impl(File, ...)`; the receiver pattern's head constructor in
   `impl(generic(T), ArrayList(T), ...)`) and forced when (a) a method lookup
   on that type misses, (b) the type's own pending binding is forced (so
   `File`'s impls follow `File`), or (c) module end.
3. **Forcing a function binding is two-phase**: phase A evaluates the signature
   head and binds a FuncVal with the real `func_id` and an *unevaluated body*
   (the principled version of today's shell); phase B evaluates the body. A
   re-entrant force of the same binding during its own phase B returns the
   phase-A value — that is how mutual recursion type-checks. Only a comptime
   CALL that needs the body of a binding whose phase B is in progress is a
   genuine cycle.
4. **Cycles are errors with a chain**: `cyclic definition: a (line 12) → b
   (line 40) → a` — for type definitions that mention each other by value,
   for comptime constants, and for phase-B-needs-body recursion. Function
   signature/body recursion (rule 3) is not a cycle.
5. **Everything is forced at module end, in source order.** Laziness changes
   ORDER, never coverage: an unreferenced broken definition still errors, `yo
   check` and the LSP still see every diagnostic, and `export(...)` forces
   the names it exports.
6. **Statements see only what precedes them** (unchanged): an `open(import(...))`
   at line 50 does not bring names into a definition forced from line 30. The
   documented rule becomes "imports, opens, pragmas and module globals are
   ordered; definitions are not".
7. A deferred binding's RHS must not READ a module-level mutable global's
   value at comptime (already true today — module globals are runtime values).
   The evaluator rejects it explicitly ("definition `x` reads module global
   `g`, whose value depends on statement order") instead of producing an
   order-dependent result.

## 4. Design

### 4.1 Pending bindings in the env

`Variable` (`src/env.yo:123`) gains a `pending : Option(Box(PendingDef))`
(rare; boxed like `consumed_at_token`) holding the RHS `AstExpr`, the defining
module env (a REFERENCE to the module frame — never a copy; see
`YO_SELF_ENV_SHARING.md`), the `EvalContext` snapshot needed to re-enter
(`expected_type` cleared, `force_compile_time_bindings`), and a `state :
Unforced | ForcingHead | ForcingBody | Done`.

`evaluate_anonymous_module_begin_exprs`' per-expression branch classifies each
compile-time binding — `is_const` (`::`, `initialization_assignment.yo:100`) OR
a `BK_COMPTIME`-wrapped LHS in the `:=` / typed-`=` / declare-then-`=` forms,
i.e. exactly the set that ends up `effective_is_compile_time_only` — whose RHS
is a definition shape, and calls `env.define_pending(name, rhs, ...)` instead of
evaluating. The declare-then-assign spelling (`comptime(x) : T;` followed by
`x = v;`) defers at the ASSIGNMENT, since only then is there an RHS; a read of
`x` between the two statements is a plain "used before initialized" error as
today. Everything else takes today's path unchanged.

### 4.2 Forcing on lookup

`Environment.lookup` (`env.yo:665`) returns the Variable as today; the
CONSUMERS that need a value — `evaluate_identifier`, static-dot resolution
(`X.method`), the trait-method lookups in `env.yo` (`get_type_trait_methods_by_
name_from_env`, `get_receiver_methods_by_name_from_env`) — call
`force_pending(var, ctx, exn)` first. Forcing evaluates the RHS in the
module env at the CURRENT position (the frame has grown since definition; that
is the whole point), stores the value into `var.value`, stamps ExprInfo as if
evaluated in place, and appends the binding to the module's `field_labels` /
`module_vals` in SOURCE order (recorded at define time), so the module struct's
field order — and therefore every downstream id — does not depend on force order.

### 4.3 Two-phase function forcing

Phase A reuses `_trial_eval_fn_type_head` (impl.yo) generalized to free
functions: evaluate the `fn(...) -> R` head in the module env, mint the
FuncValData with `body : <AST>` and `func_id` — exactly today's FuncVal minus the
body evaluation. Phase B runs `_trial_eval_fn_body`. The FuncValData is
`box`ed (`calls/helper.yo:1689`'s shape), so phase B **updates it in place** —
no orphan/shell pair, the class that produced
`forward-ref-shell-orphan-duplicate-emission.md`.

### 4.4 Pending impls

A per-module `pending_impls : ArrayList((head : String, expr, state))`.
Trait-method lookup misses on a type whose nominal name matches a pending head
force those impls (Case 2 and Case 3 alike — the Case 2 registry problem of the
2026-08-13 attempt does not arise because we evaluate the REAL impl, not shells).
Forcing the type's own binding also forces its impls, so `File.open(...)`
inside a free function finds `impl(File, ...)` whether it is above or below.
Impls whose receiver head is not a simple atom (rare) are forced at the first
miss of ANY method lookup, then at module end.

### 4.5 Retiring the shell pre-pass

Once 4.3 exists, `_try_create_forward_shell` and the `__forward_shell`
supersede path (impl.yo Case 3, ~:3199-3238) become a special case of forcing
sibling fields (an impl block's fields are pending bindings scoped to the block).
Retire them in P3, after the corpus proves the general mechanism — not before.

**LANDED 2026-09-05** — see §10 "P3 as landed" for the shape that replaced them.

### 4.6 Diagnostics (lands FIRST, independently — P0)

**P0 LANDED 2026-09-02** (the fn-body dg trial, the anon-closure concrete
and dgc trials): the module walker records its begin_exprs + live index in
context.yo (`set_module_walk` family — accessor functions, the
g_rerun_pending pattern, so nested module loads save/restore correctly);
`forward_ref_diagnostic` there parses the swallowed
`Variable "X" not found.` and scans for a LATER binding (`::`/`:`/`=`,
`comptime(X)`, `impl(X, ...)` heads). The silent sites re-raise
`forward reference to "X" (defined at line N) — Yo evaluates definitions in
order; move the definition above this use` — pinned end-to-end by
`tests/cli-cases/check-forward-ref-async-body/` (a check-failure case; the
test-batch runner hoists `::` defs so a .test.yo pin cannot observe module
order). NOT yet wired: the bounded pending-def re-run site (the
fwd-comptime-fn arm has no exn in scope; smaller exposure — it retries
before discarding). Also learned: plain module-level SELF-recursion fails
check today ("Variable X not found" at the def trial) — the campaign's
own §6 target.

`_trial_eval_fn_body`'s swallow already records the message
(`_flag_trial_swallow`). Add: when the swallowed error is an unbound-name /
no-matching-call error AND the name is a compile-time binding (any spelling of
rule 1) or impl receiver that appears LATER in the same module's `begin_exprs`, re-raise through the real
`exn` as `forward reference to "X" (defined at line N) — Yo evaluates
definitions in order; move the definition above this use`. This converts the
silent hollow into a check-time error today and stays as the cycle/statement
error text after the campaign.

## 5. Interactions

| area | effect | handling |
| --- | --- | --- |
| def-eval swallow (`def-eval-swallow-remaining-roots.md`) | the "later binding" root class disappears; the remaining swallows are genuine type errors | measure the root census before/after (§7); keep the swallow for the deferred-generic path only, as today |
| C22 stub gate | fewer stubs; the gate stays as the deadness oracle | count `__attribute__((error))` stubs in the std/src self-emit before/after |
| ExprInfo / yo_id | forcing evaluates the RHS AST once, at force time; ids are minted in force order | module field order is source order (4.2); for order-correct code force order == source order, so ids are identical (§6) |
| codegen `function_order` (`codegen/functions/generation.yo:895`) | insertion order = force order | same argument: identical for today's corpus; for new forward-ref code it is deterministic given the source |
| fixpoint (stage-2 ≡ stage-3) | any nondeterminism in force order breaks it | forcing is driven by a deterministic AST walk; no hash-map iteration may decide force order (the `yo-self-emission-order-nondeterminism` lesson) |
| env sharing / memory | a pending def holds the module frame by reference, no copy; forcing late sees a bigger frame | `Frame.name_index` already supports growth; measure peak footprint on the self-emit (§7) |
| LSP (`check_watch`, `allow_partial_module`) | diagnostics must be complete → module-end forcing (rule 5); hover/definition on a pending name forces it | LSP goldens `lsp-*`, `check-watch-once` pin the observable output |
| macros / `quote` | macro definitions are `::` bindings → deferred like functions; expansion sites force them | `tests/macro_*.test.yo`, `quote_macro_eval` |
| module globals `(g : T) = v` | ordered statements; a definition reading `g` at comptime is rejected (rule 7) | new negative test |
| SEED gate | the implementation must compile under the CURRENT seed (v0.2.21) — it may not itself use forward references; `std/` and `src/` may start using them only after the release carrying the feature becomes `SEED_VERSION` | `yo-seed-gates-source-forms`; the `.github/instructions` note flips at that bump |
| `docs/en-US/IMPL_FORWARD_REFERENCES.md` (+ zh-CN) | rewritten as "Definition order" covering module scope; the impl-block section becomes a special case | P4 |

## 6. Acceptance test: byte identity on today's corpus

Every program in the tree is order-correct today, so for the whole corpus
force order == source order and the emitted C must be **byte-identical**
before/after the campaign (`yo-byte-identity-gate-for-additive-codegen-change`:
record `sha256` of the stage-2 self-emit and of every test batch `.bin.c`
BEFORE the first edit — with NO concurrent edits to the tree during the
baseline emit, the trap hit on 2026-09-01). `same=N diff=0` makes the fixpoint
argument free. Any diff is a bug in the forcing order (or a genuine
improvement that must be explained line by line, as the env-sharing PR did).

Then the NEW behaviour is pinned by tests that are red today:
- free-function mutual recursion (`is_even`/`is_odd` as bare `::` bindings),
  and the same pair spelled `comptime(is_even) := ...` / `(comptime(is_odd) :
  fn(...) -> bool) = ...` — every compile-time binding spelling defers alike;
- a caller above its callee, a type used above its definition, a constant
  used above its definition;
- an `impl(T, Trait(...))` BELOW a free function that calls the trait default
  on a `T` (the `std/fs/file.yo` shape) — and below a `Dyn(Trait)` use;
- two `impl(P, ...)` blocks referencing each other's methods;
- `export(...)` naming a definition that appears after it;
- negatives: a cyclic constant pair, a comptime call into a body being
  evaluated, a definition reading a module global, an `open(import)` after
  a use — each with the exact diagnostic text pinned (`comptime_expect_error`).

## 7. Phasing and gates

| phase | scope | gate |
| --- | --- | --- |
| **P0** diagnostic | §4.6 only, no semantic change | `check ./std` + `./src` unchanged; the `std/fs/file.yo` shape (recreated in `tests/`) errors at check time with the new message; battery green |
| **P1** pending `::` bindings | §4.1–4.3 for `::` definitions; module-end forcing; cycles | byte identity on the corpus (§6); positive tests for free-fn forward refs + mutual recursion; def-eval root census (`YO_DEBUG_SWALLOW=1 check ./std` roots) must not grow |
| **P2** pending impls | §4.4 | byte identity holds; the file.yo shape and cross-impl-block tests green; C22 stub count in the self-emit does not grow |
| **P3** retire shells (**LANDED 2026-09-05**) | §4.5; delete `_try_create_forward_shell` + supersede path; `tests/forward_ref_impl_block`/`forward_ref_self_method` stay green | byte identity **modulo id renumbering** (§10 P3 — the pre-pass consumed ids and emitted dead thunks, so exact identity cannot hold); battery; hollow sweep ratchet |
| **P4** docs + rules | rewrite `docs/{en-US,zh-CN}/IMPL_FORWARD_REFERENCES.md` → definition order; update `.github/instructions/yo-syntax.instructions.md`, both skill cheatsheets; `docs/*/DESIGN.md` language section | doc build green (`yo doc ./std`) |
| **P5** release + seed bump | ship in the next patch release; after `SEED_VERSION` advances, the "no forward refs in std/src" rule is lifted and the holder workarounds in `src/` (`forward-fn-ref-in-toplevel-holder.md`'s pattern) can be removed | fixpoint on the first tree that USES forward refs in `src/` |

Every phase also gates on: `yo check ./std && yo check ./src`, the full language
suite, `gates_fast.sh` + `fixpoint_only.sh`, the hollow sweep ratchet, and the
LSP/CLI goldens (54/55 scorecard, `--network` included).

**Measure first (before P1 code):**
1. The def-eval swallow root census over `./std` + `./src` split by cause —
   how many roots ARE forward references (candidates to vanish) vs genuine
   errors. The 2026-08-13 attempt discovered too late that its target family
   was not the forward-ref class at all.
2. Where the def-time trial runs relative to the module loop for `impl`
   fields (the "in-flight context lists EMPTY at the trial site" contradiction
   recorded in `def-eval-swallow-remaining-roots.md`) — decides whether impl
   forcing can be scoped per block or must be module-level.
3. Peak footprint and wall time of the stage-2 self-emit (baseline vs P1) —
   pending defs are cheap, but forcing late can grow `Frame.name_index`
   walks; the memory campaign's r15 numbers are the reference.

## 8. Risks

- **Registry-perturbation family.** Any deviation in force order from source
  order on today's corpus changes yo_ids/type keys and can flip latent
  order-sensitive bugs (this week: #374 → the dyn redefinition). The byte-
  identity gate is the mitigation; do not accept "same fixpoint, different C".
- **Error attribution.** A forced definition's error must name the definition
  AND the forcing chain; without it, errors surface at a use site 300 lines
  away. Part of P1's definition of done.
- **Scope creep into the swallow rework.** Tightening the def-eval swallow to
  fatal (the TS behaviour) is a separate arc (`arity-validation-outside-the-
  swallow`, C22-async-SM gate); this plan removes one root CLASS, it does not
  change the swallow policy.
- **Seed lag.** A full release cycle passes before `std/`/`src/` can rely on
  the feature; the P0 diagnostic is what protects the tree in the meantime.

## 9. Open questions

- Should NON-definition comptime constants (`platform :: __yo_process_platform()`)
  be deferred? Proposed yes (rule 1) — they are pure by construction (`::`
  requires a comptime value) — but a CTFE call with reflection side effects
  (`__yo_expr_to_string`) needs a check.
- Bare-name references to sibling `impl` methods (`callee()` instead of
  `self.callee()`) stay unsupported (the shadowing argument in
  `IMPL_FORWARD_REFERENCES.md`); module-level bare names ARE the feature.
- Whether `impl` forcing on a method MISS is acceptable in the LSP's
  completion path (a completion request on `x.` would force all of `x`'s
  type's impls — desirable, but measure latency on `src/lsp` goldens).

## 10. As landed (2026-09-05) — adjustments to the design above

- **Forcing is miss-driven, not lookup-driven (§4.1/§4.2).** Pending entries are
  NOT put into the module frame as placeholder Variables: a pre-scan records
  them in a per-walk table (`ModuleWalk`/`PendingDef`, `src/evaluator/context.yo`)
  and the walker evaluates statements in source order, skipping entries an
  earlier reference already forced. The forcing hook sits on the lookup MISS
  paths only — `evaluate_identifier_and_operator`'s "Variable not found" arm,
  `export(...)` of an unbound name, and the fatal method/trait-miss sites
  (`_try_find_receiver_method`, the where-clause / `<:` / trait-where checks).
  A miss is an error today, so no order-correct program changes; the
  byte-identity gate (§6) holds by construction rather than by argument.
- **Deferred class = the `::` spelling (rule 1 narrowed).** `(comptime(x) : T) = v`
  and the declare-then-assign `comptime(x) : T; x = v` spellings route through
  `evaluate_binding`/`evaluate_assignment`, whose declare-then-fill semantics
  are order-dependent by design (the split form IS the pre-existing
  mutual-recursion idiom, fn arm 14). They stay ordered statements; the
  bounded pending re-run that serves the split form is unchanged.
- **Frozen-frame visibility.** Def-time body envs and call-time capture envs are
  private frame COPIES, so a definition forced mid-trial is invisible to the
  ~100 by-name env lookups that follow the identifier. The resolved Variable is
  ADOPTED into the current env's copy of the module frame (matched by
  `Frame.id`) or, in a flat capture env, into its capture frame
  (`adopt_resolved_definition`). Finished walks keep their tables so a
  specialization after the walk still resolves.
- **Impl forcing is by receiver head name at fatal-miss sites (§4.4)**, plus the
  un-nameable heads; the receiver type's nominal head is compared to the impl
  head atom. `Dyn(Trait)` coercion of a value whose impl appears later is not a
  forcing site (its implements-check is a boolean inside compatibility).
  **No forcing while an impl of the same type is in flight**: a method miss
  inside `impl(Sha1, …)` is the in-block sibling case that in-block field
  forcing owns (P3 below; the shell pre-pass before it);
  forcing the later `impl(Sha1, Digest(...))` there evaluated it against a
  half-registered type and its trait methods resolved through the trait
  record (`__yo_t18.update`, tests/crypto/digest.test.yo). So cross-block
  references force from free functions / generic bodies / other types' impls,
  not from inside another block of the same type (§6's "two impl blocks
  reference each other" is narrowed accordingly).
- **Ordered-statement forward references** keep the P0 diagnostic, reworded
  (`forward reference to "X" (bound at line N) — imports, opens, pragmas and
  runtime bindings are evaluated in order …`), now also raised from the
  concrete-fn trial site and covering the typed-global `(g : T) = v` spelling.
- **Surfaced along the way:** concrete function bodies were never checked
  against the declared result type
  (`issues/fixed/concrete-fn-body-result-type-not-checked.md`) — fixed in the
  same PR.
- **P5** is seed-gated: `std/` and `src/` may use forward references only after
  `SEED_VERSION` carries this release (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

### P3 as landed (2026-09-05) — impl-block members are forcible pending fields

- **What was removed.** `_try_create_forward_shell` (the Case 3 eager shell
  pre-pass that trial-evaluated every member's fn-type head and registered a
  bodiless `__forward_shell` FuncVal), `materialize_in_flight_method` (the Case 2
  lazy shell materializer), the `__forward_shell` supersede branches,
  `register_shell_redirect`/`get_shell_redirect` (`type_trait_methods.yo`) and
  the codegen "forward-shell thunk" emission + `_thunk_forward_args`
  (`codegen/functions/generation.yo`). Nothing named "shell" is left in the
  impl path.
- **What replaced it.** An impl block under evaluation is an `ImplInFlight`
  record (`src/evaluator/context.yo`): receiver id, env, the block's members as
  `ImplPendingField`s (label, colon-pair expr, top-level arg index, `is_inner`
  for trait-constructor members, an `Unforced/Forcing/Done/Failed` state, the
  result type/value, and a `PendingDef` so the member rides the same forcing
  stack as a `::` definition). The member loops in `impl.yo` (Case 2 generic,
  Case 3 concrete) route every direct member through the record: `Done` skips,
  `Failed` re-raises the parked error at the member's own position, `Unforced`
  evaluates in place. The method-lookup MISS inside the block
  (`get_receiver_methods_by_name_from_env` / `get_type_trait_methods_by_name_from_env`
  in `src/env.yo`, via the `set_force_in_flight_field_fn` hook →
  `force_in_flight_field` in `impl.yo`) forces the referenced sibling's REAL
  evaluation — real func_id, real body — then re-queries the permanent and
  provisional registries. Forced members are evaluated with the block's env and
  a clean expected-type / where-trait / def-time-trial context, and the forcing
  depth is truncated on failure exactly like a forced `::` definition.
- **Mutual recursion** rides the P1 phase-A publication: while member `A` is
  `Forcing` and its body references `B`, `B` is forced; when `B`'s body
  references `A` back, the hook finds `A` in the `Forcing` state and registers
  `A`'s phase-A FuncVal (`pf.def.phase_a_value`, published by
  `publish_pending_phase_a` from the fn-type trial) as a method entry — so the
  call binds to the real func_id and specialization proceeds through the
  in-flight stack (`tests/forward_ref_impl_block.test.yo` tests 2/4/6).
- **Inner (trait-constructor) members** are forcible only while their own
  trait entry is the current one (`impl_forcible_field` → `current_top_index`),
  and Case 3 inner members keep the provisional-signature splice that already
  existed; direct members of a block are forcible from any sibling.
- **Error attribution.** A forced member with a genuine error is marked
  `Failed`, its message gets the note "`X` was evaluated here because a sibling
  method of this impl references it before its definition", the parked error is
  thrown by the method-call no-method arm, and the block loop re-raises it when
  it reaches the member — pinned by
  `tests/cli-cases/check-forced-impl-member-error-attribution`.
- **Byte identity changed shape, as §7 predicted.** Against the P0–P2 binary,
  the 156 `tests/codegen-bootstrap` emissions split into 10 byte-identical,
  145 identical modulo renumbering (the prelude's shell pre-pass consumed 49
  ids, so every later `yo_id_N`/`struct_yo_id_N` shifts, and the shift permutes
  hash-ordered `__yo_tN` C type-name assignment and type-declaration order) and
  ONE — `comptime_param_value_spec` — that additionally LOSES four lines: the
  dead `fn_yo_id_*_new_with_keys` thunk the old binary declared, defined and
  never called (`DefaultHasher.new_with_keys`, referenced before its definition
  in `std/hash.yo`). Blind-normalizing numeric suffixes and comparing line
  multisets is the check that classified them (155/156 equal, 1 = the thunk).
  The `lsp-completion` golden pins raw struct ids in completion `detail`
  strings and was re-recorded for the same shift. Fixpoint (stage-2 ≡ stage-3)
  is the identity gate that still applies unchanged.
- **Unwind safety (surfaced in review; pre-existing on the shell design too).**
  An impl abandoned by a throw in its member loop never reaches its own pops;
  a stale in-flight record then let a later method miss force a member of the
  abandoned block into existence (`issues/fixed/abandoned-impl-members-survive-the-error.md`
  — on develop the shell pre-pass had registered the same member permanently
  before the throw). `ForcingDepths`/`forcing_depths`/`truncate_forcing_depths`
  (context.yo) snapshot the three stacks; every catch-and-continue site
  (`comptime_expect_error`, the fn/closure body-trial swallows, the
  pending-definition forcer, the field forcer, the trait-default materializer,
  the walker abort edge) truncates back after its guarded evaluation.
- **`YO_DEBUG_LAZY=1`** now also prints `[force-field] <type>.<member> (impl
  arg N, inner=…)` and `[force-field] phase-A <type>.<member>` for every
  in-block force.
