# Macro and Iso removal — comptime-only metaprogramming, Rust's thread rule

**Status:** WRITTEN 2026-10-20, revised 2026-10-20 after review; scheduled in
the VBD campaign (see "Schedule" at the end). **Part A pulled forward to
v0.2.68 (maintainer, 2026-10-21)**: see "Part A moves to v0.2.68" in §0.2. This is the decision record and
campaign for two maintainer decisions of 2026-10-20, both approved:

1. **Delete the macro layer.** Reverses `plans/reference/MACRO_POLICY.md`
   (2026-08-21, "keep, gate, shrink the expansion tax").
2. **Delete the builtin `Iso(T)` and `^v`.** Supersedes the `Iso` carve-outs in
   `plans/VALUES_BY_DEFAULT.md` §3.6/§3.8 (:631, :695) and the "Iso stays —
   role unchanged" line of the `FUTURE_ORIGINS.md` sketch (added 2026-05-19), which #1483
   deleted (`plans/backlog/REFERENCES_AND_ORIGINS.md`, its successor, does not
   mention `Iso`).

Anchors were re-verified on develop `8203bd867` (2026-10-20), which includes
#1492: std now declares `pragma(Pragma.AllowMacroDef)` itself, and the
bootstrap std exemption is gone. They still hold on `400413ac3` (#1496
touched only `src/evaluator/values/array.yo` among the cited trees). Expect drift as develop moves. Each part
re-runs its grep gates at execution time instead of trusting a line number.

## 0. The decisions, and what they honestly retract

### 0.1 No user-defined macros

Position: Yo's extension mechanisms are comptime functions, the type layer
(comptime kinds, HKT, GADTs) and the quote/reflection layer. The macro layer —
the two signature flags (`quote(p) : Expr` parameters, `-> unquote(Expr)`
returns), the func-id registries, the call dispatch, and
`Pragma.AllowMacroDef` — is deleted. What the live std macros do survives as
parse-time desugars or direct builtin calls, following the `if` → `cond`
precedent (landed 2026-08-21; prelude `if` macro deleted 2026-08-30). The
exception is the three collection literals, whose call surface is deleted
outright and replaced by ordinary constructors (B3). Yo is written by LLMs,
and terse literals are human ergonomics an LLM author does not need (the
`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` direction).

Why the 2026-08-21 "keep" verdict no longer holds — every load-bearing fact
behind `MACRO_POLICY.md` §1.5 has since changed direction:

- "`try` alone justifies the mechanism" — `try` was removed the same day
  (policy §3.1), and the proposal to restore it
  (`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3) never landed.
  Part C closes that backlog item as rejected.
- "Zig pays with builtin `if`/`for` syntax" — we accept exactly that price
  (maintainer, 2026-10-20). `if` already pays it; `for` joins it in Part B
  (`for_await` was deleted outright on 2026-10-24, B2).
- The forwarder the policy called irreducible is not needed: `unsafe.drop`
  is a pure rename — its whole body is `quote(___drop(unquote(value)))`
  (`std/prelude.yo:248`) — and every caller is a std file or test fixture
  that may name the `___drop` builtin directly (B4). The policy's objection
  (each forwarder "exists precisely to reify the CALLER's lvalue") is about
  a wrapper function, which B4 does not introduce.
- The expansion tax the policy itself named "the real maintenance pain" —
  the hand-replicated `ExprInfo.macro_expansion` chase sites, where "nothing
  enforces this; the failure mode is silent" — is still billing: an open S2
  (`issues/a-macro-that-duplicates-an-fnonce-call-calls-it-twice.md`) and,
  fixed only days ago by re-landing a scope-aware local-borrow live-range
  scan, the module-level borrow-across-expansion S2
  (`issues/fixed/2026-10-17-a-module-level-local-borrow-is-not-checked-across-a-call-a-macro-expands-to.md`),
  on top of the earlier incident list (heap-corrupting macro dispatch, the
  275/315-error lost-expansion transpile cascades).

What removal does and does not buy, stated honestly: the macro-specific bugs
go away — the macro-site borrow rule, the call dispatch, quoted-argument
binding, expansions whose tokens belong to another module. The chase pattern
mostly stays. Six non-macro lowerings also write the `macro_expansion`
channel (§1.1, C3), so the channel survives under a new name and most
consumers keep following it. The saving is the macro machinery, not the
chase sites.

What survives untouched (policy §1.3, still true): `quote`, `unquote` inside
quoted code, `unquote_splicing`, `gensym`, `Expr`/`ExprList`, `EvalValue.ExprVal`,
`clone_expr_fresh_ids`, the `__yo_expr_*` reflection builtins (read-only
syntax queries, `src/expr.yo:251-256`), and all of `derive`. That layer is
comptime AST work dispatched ungated, and derive is its biggest user. Derive
generators are ordinary comptime functions
(`fn(comptime(T) : Type, comptime(ctx) : DeriveContext, …) -> comptime(Expr)`)
and touch none of the macro registries. "Remove macros" removes exactly the
two signature flags, their registries, the gate, and the macro-call dispatch.

**`derive_rule` is the one surviving item-level splice, by intent.** Once
unquote-returns are gone, a user derive rule (`docs/en-US/DERIVE_TRAITS.md`,
"`derive_rule` — User-Registrable Derive Rules") is the only way an `Expr`
value becomes code. `_derive_eval_guarded` (`src/evaluator/builtins/derive.yo:97-110`,
called at :387) evaluates whatever the rule returns in the caller's env,
with no shape check. C2 restricts that result to items — `impl(...)` and
trait applications, the only things a derive emits (Rust's derive emits
items only) — so a derive rule cannot become a back door for statement
macros. A non-item result is a diagnostic naming this doc.
`comptime_eval`, which parses a string and evaluates it in the caller's env,
is the other way data becomes code; this plan does not touch it, and
`plans/backlog/COMPTIME_METAPROGRAMMING_AUDIT.md` §2 restricts it to
declarations, the matching rule.

### 0.2 Rust's thread rule; no `Iso`

Position: data that crosses threads must itself be `Send`; `Rc` graphs are
thread-local. If you hold the only handle to an `Rc`, the bridge to a movable
value is `Rc.try_unwrap` — already shipped (`std/prelude.yo:9843`, Rust's
`Rc::try_unwrap` semantics on a consumed handle; `Arc.try_unwrap` at
`:10174`), a shallow single-cell check. `Iso(T)`, the `^v` operator, the
`Var.*` introspectors and the `Isolation` trait are deleted.

What this retracts, stated plainly: the one-shot, zero-atomic, zero-copy
handoff of a uniquely-owned acyclic `Rc` graph to another thread.
`try_unwrap` does not cover that case — extraction is shallow, and a graph
with interior non-atomic cells has no extractable `Send` form. That graph
case was exactly and only `Iso`'s domain (the bound rejects `Iso(i32)` as
redundant), and Rust forbids it too (`tests/iso.test.yo`'s `Box(Rc)` cases).
The decision is to adopt Rust's rule — `Rc` does not cross threads;
restructure with `Arc`, rebuild into values, or serialize — and accept those
substitutes.

**Why `Iso` goes — it conflicts with VALUES_BY_DEFAULT:**

- **VBD decision 8 says "there is no isolation walk"** (`plans/VALUES_BY_DEFAULT.md:1608`:
  "`Send` is a move; `Sync` is sharing (§3.8). There is no isolation walk").
  §0.1 rejected copy-on-write partly because it "needed a transfer-isolation
  walk at every thread boundary" (:219). The §3.6/§3.8 `Iso` carve-outs are
  the one exception, and this plan removes them.
- **`Iso` is a third counted handle.** VBD §0.1 makes `Rc` and `Arc` the only
  counted things. `Iso`'s handle is atomically counted, copied implicitly,
  and guarded by a runtime one-shot flag: `tests/iso.test.yo:10-14` copies
  one `Iso` twice, and the first `extract` on any copy wins while every
  later one panics (`std/prelude.yo:10066-10075`). V2c makes implicit handle
  copies E0901, so `Iso` would need its own clone story.
- **Its safety rests on a runtime deep walk over a user-implementable
  trait.** `^v`'s uniqueness walk descends through the cycle collector's
  traversal functions (`src/codegen/codegen_c.yo:520-522`: "The same
  traversals serve Iso's uniqueness walk (rule D2)"), and `Trace` is a safe
  trait any reference type may implement (`std/prelude.yo:343-352`). A
  runtime-proved `Option`-yielding walk was also the one runtime safety
  proof left in a language moving everything else to compile-time proof. It
  also couples `Iso` to decision 46's collector-predicate follow-up (VBD §6
  "Decision 46" step 3), which would otherwise have to keep `Iso`'s
  traversals complete.
- **It has a live `Send` hole.** `Iso(T)` is `Send` for every `T`
  (`std/prelude.yo:10064`), and the graph walk at construction
  (`_iso_function_offense`, `src/evaluator/calls/iso.yo:74`) refuses only
  function values and a `Dyn` without `Send`. So `^w` over a
  `ref(struct(io : Io, r : Rc(i32)))` moves the thread's `Io` to another
  thread, while capturing the same `Io` directly is rejected
  (`issues/retired/2026-10-20-an-iso-graph-holding-a-non-send-handle-crosses-threads.md`).
  **The window is ACCEPTED until Part A** (maintainer, 2026-10-20). No interim
  fix: Part A lands before decision 43 step 2 (Schedule). Step 2 keeps the
  storage wall (E0909) and step 3 (N2) is the one that lets references sit
  in fields, so landing before step 2 is the stricter ordering and the hole
  never widens before it is deleted.

**Why not first.** Today `Iso` is the only safe way to move a `String` or a
collection to or from another thread. On develop `8203bd867` (re-checked
with a tree binary), `Thread(ArrayList(String))`
and `arc(String.from(...))` are E0602, and a spawn closure capturing a
`String` is rejected with "wrap it in Arc/Iso". `PARALLELISM_RULES.md` D10
says why: "Until V2b gives `String` and the collections unique buffers, they
reach a non-atomic cell and are not `Send`". V2b's `Send`-by-move makes the
plain-value payloads the common case, and obsoletes the docs' "use Iso until
`Channel(String)` works" stopgap, only once its B8–B11 flips land (VBD §6
V2). Part A therefore followed B11 in the 2026-10-20 schedule, and its gate
included the replacement probe: the same transfer, written without `Iso`,
must compile on the tree that deletes `Iso`.

**Part A moves to v0.2.68 (maintainer decision, 2026-10-21).** The
"why not first" ordering above is superseded. Nothing in `src/` or `std/`
uses `Iso` outside its own surface, and deleting it closes its two open
safety holes instead of accepting them for two more releases: the `Send`
hole above
(`issues/retired/2026-10-20-an-iso-graph-holding-a-non-send-handle-crosses-threads.md`)
and the collector-handoff use-after-free S1
(`issues/retired/2026-10-20-iso-sends-collector-tracked-objects-to-another-thread.md`;
both docs retire with Part A). The accepted cost:
from v0.2.68 until V2b's B8 flip (v0.2.70) no `String` or collection can be
moved to another thread. The substitutes in that window are an `Arc` of
`Send` data, a value rebuilt on the receiving side, or serialization; the
docs say so where `Iso` was the documented stopgap. The replacement probe
cannot pass before B8, so it moves to B8's gate (A6, and
`plans/VALUES_BY_DEFAULT.md` §6 B8).

Nothing in `src/` or `std/` outside the feature's own surface uses `Iso`
(the `Isolation` trait has no callers outside the prelude besides the
`property_access.yo:1385` arm, and `std/allocator.yo:290` mentions it only
in a doc comment).

## 1. Inventory (develop `8203bd867`, 2026-10-20)

### 1.1 Macro machinery (deleted in Part C)

| Piece | Site |
| ----- | ---- |
| quoted-param / unquote-return registries | `src/evaluator/types/function.yo:99-191` (`g_macro_quoted_param_indices` :100, `register_macro_return_is_unquote` :118, `is_macro_fn` :139, FuncVal-id re-keying) |
| `Pragma.AllowMacroDef` gate | `src/evaluator/types/function.yo:4570-4593` (fires on `quoted_param_indices.len() > 0 \|\| is_return_unquote`; message at :4581) |
| gate helper | `src/evaluator/memory_safety.yo:249-262` (`is_macro_def_capable_file`: the pragma, or an `auto-generated://` module; #1492 deleted the std exemption) |
| pragma recognition | `src/evaluator/builtins/pragma.yo:39, 168-176` (variant map + AST-shape fast path); the variant at `std/prelude.yo:86` |
| pragma lines in std | `std/prelude.yo:137`, `std/async/stream.yo:109`, `std/encoding/json.yo:61` (json defines no macro, only derive rules), `std/collections/array_list.yo:12`, `hash_map.yo:27`, `hash_set.yo:34` (the three collection lines go in B3 with their macros) |
| call dispatch | `src/evaluator/calls/function.yo`: `MACRO_DISPATCH_ENABLED` :139 (export :11843), `fv_is_macro` :9155, quoted-arg binding, force-execute context flags, unquote-return splice + expansion recording :10569-10611 |
| `macro_expand(...)` builtin | `src/evaluator/builtins/macro_expand.yo` (278 lines; **no user call sites anywhere** — wiring: dispatch arm `src/evaluator/exprs/_expr.yo:1239-1240`, `BF_MACRO_EXPAND` `src/expr.yo:70` + export `:1057`, lexer fast path `src/token.yo:143`) |
| macro-site borrow tracking | `src/evaluator/utils.yo`: `g_lb_macro_sites` :149, `macro_site` field :5296, `_lb_macro_site_of` :5323 (fires only when the declaring token's module differs from the site's), `LocalBorrowMacroSite` :5343 (with `await_ids` for rule 4), `local_borrow_enter/leave_macro_site` :6048/:6054, the `info.macro_site` help text :5727 |
| expansion side table | `src/expr_info.yo` (`ExprInfo.macro_expansion` :385, accessors :610/:618, durable fallback `g_macro_expansions` + `record_macro_expansion` / `lookup_macro_expansion` :2565-2574). `git grep -c macro_expansion -- src`: 25 files, 143 lines, including the verifier (`src/verifier/vc.yo:112, :2773, :3287`) |
| non-macro writers of that table | `src/evaluator/calls/function.yo:937-938` (the `Copy` `.clone()` lowering to its receiver); `src/evaluator/utils/closure.yo:1472-1473` (`_expand_clone_to`, the structural clone); `src/evaluator/exprs/match.yo:1427` (match-arm pattern tests hung off the `=>` node, which codegen walks but never generates); `src/evaluator/exprs/initialization_assignment.yo:547, :945` (the local-borrow pin channel); `src/evaluator/calls/pointer_type.yo:176-177` and `numeric_type.yo:460-461` (pointer and numeric casts lowered to `__yo_as`) |

The last row is why C3 renames the table instead of deleting it. The code
says the node cannot be rewritten in place: "Codegen walks the original
parsed node … codegen does NOT see returned rewrites … the enum node cannot
be mutated in place, so the existing macro_expansion mechanism carries it"
(`pointer_type.yo:131-139`).

### 1.2 The nine live std macros

| Macro | Definition | Callers | Fate |
| ----- | ---------- | ------- | ---- |
| `for` | `std/prelude.yo:10645` | **6 in src**: `src/doc/builder.yo:2212`, `src/evaluator/builtins/comptime_expect_error.yo:287` (`for(&saved_observed_msgs, …)`, which today's sigil rewrite turns into the value form and V2b's B7 Generation B turns into the read walk), `src/evaluator/shared/suspension_analysis.yo:668`, `src/lsp/server.yo:876, :1242, :1260`; 0 std; ~190 in tests/ | desugar (B1) |
| `for_await` | `std/async/stream.yo:446` (deleted 2026-10-24) | tests only (`tests/async/combinators.test.yo:10` also imported it by name); rewritten to the explicit loop | deleted, no desugar (B2, 2026-10-24) |
| `(^)` | `std/prelude.yo:10076-10132` | 0 src, 0 std; the Iso test files (A6) | deleted with Iso (A1) |
| `Var.is_owning_the_rc_value` / `Var.has_other_aliases` | `std/prelude.yo:8240-8257` | 2, inside `(^)` itself | deleted with Iso (A1) |
| `unsafe.drop` | `std/prelude.yo:248` | 12 in std — `array_list.yo:513, :584, :609`, `deque.yo:256`, `hash_map.yo:812, :878, :959`, `sync/channel.yo:270, :324, :381`, `prelude.yo:9991`, and `prelude.yo:10120` inside `(^)`'s quoted body (planned to go with A1; B4 rewrote it to `___drop` since A1 had not landed) — plus `tests/fixtures/owned_buffer.yo:50` | rewritten to `___drop` (B4) |
| `array_list` | `std/collections/array_list.yo:1844` | 8 in `src/parser.yo` (:1235, :1585, :1586, :1603, :1754, :1783, :1824, :1915) | deleted, surface removed (B3) |
| `hash_map` | `std/collections/hash_map.yo:1515` | tests only | deleted, surface removed (B3) |
| `hash_set` | `std/collections/hash_set.yo:474` | tests only | deleted, surface removed (B3) |

The three literals have 47 test lines across four files:
`tests/closure_capture_rc_leak.test.yo` (14), `tests/collection_literals.test.yo` (15),
`tests/iterator_combinators.test.yo` (16) and
`tests/codegen-bootstrap/closure_where_clause_param.yo` (2). No docs or
skills use them.

**The seed builds macro calls.** `src/` has six `for` loops (and, until B4
rewrote them to `___drop`, `std/` had eleven `unsafe.drop` calls outside
`(^)`), and the seed expands every one of them
when it builds the tree. The parser's eight literal sites are seed-built
too. That, not only CI tooling, is why the prelude macros stay until a
release carrying the desugars is the seed (Part B's retained-macro rule).
`VALUES_BY_DEFAULT.md:3341-3342` ("neither `src/` nor `std/` writes a
borrowed `for`") still holds: `comptime_expect_error.yo:287` spells `&`, but
today the decision-42 sigil rewrite (`src/expr.yo:1719-1728`) strips a bare
`&` to the value form; only `&mut` selects the borrowed form. That changes
before B1: V2b's B7 Generation B (VBD §6, "B7 proper") makes `for(&xs, x => …)`
the read walk over `c := &xs` with a `walk_ref` projection, so at B1 time
`comptime_expect_error.yo:287` is a borrowed (read) `for` in `src/`. B1
reproduces whatever three forms the macro has then: value, `&` read walk,
`&mut` borrowed walk.

Gated user-macro fixtures (deleted or rewritten in C5): `tests/macro_def_pragma.test.yo`,
`tests/macro_def_gate.test.yo`, `tests/internal/macro_expansion.test.yo`,
`tests/internal/macro_registry.test.yo`, parts of `tests/internal/ast_reflection.test.yo`
and `tests/internal/macro_helpers.test.yo`, `tests/codegen-bootstrap/try_macro_assign.yo`,
and the local `_recv_one` macro at `tests/async/channel.test.yo:417`. **All but
`_recv_one` were deleted or rewritten early, on 2026-10-24** (maintainer
decision; branch `tests/delete-macro-fixtures-early`; what C5 still owes is
listed under C5). Not in this list before: the origins-corpus row
`tests/origins/corpus/macro-ret-local.yo` also defines a user macro. A
commented-out `fill` macro sits at `std/prelude.yo:7116-7122` ("NOTE: Macro
doesn't work yet").

### 1.3 Iso machinery (deleted in Part A)

The authoritative census is the grep gate, not this list:

    git grep -InP '\bIso\b|IsoT\b|is_iso_type|__yo_iso|iso_types|IsoTypeInfo|isolating|BK_ISO|BF_YO_ISO|\bt_iso\b|\bTIso\b|IsoValueResult|\bIsolation\b|BF_YO_VAR_|__yo_var_|\^v\b' -- ':!plans/archive' ':!plans/handover' ':!issues/fixed' ':!issues/retired' ':!issues/repros' ':!issues/patches' ':!plans/backlog/MACRO_AND_ISO_REMOVAL.md'

(Amended when Part A landed, 2026-10-21: `-I` skips the binary logos, and
`issues/repros/` and `issues/patches/` are historical files of the fixed Iso
issues, cited from `issues/fixed/`, so they are allowlisted like those docs.
Five hits are not Iso and stay: the `'^v'` regex anchors in
`scripts/install.ps1` and `tests/cli-cases/unsafe-pragma-ok/opts`, the
"Registry Isolation" heading of `plans/reference/DEPENDENCY_MANAGEMENT.md`,
the "isolating failures" quote in `plans/backlog/FSTAR_ADOPTION_CANDIDATES.md`,
and `__yo_var_print_info` (a builtin removed on 2026-09-29) in the example of
the open `issues/asm-documented-target-and-register-validation-does-not-exist.md`.)

On `8203bd867` (and on `400413ac3`) it hits 45 files in `src/`. The main ones, re-anchored:

- **Evaluator**: `src/evaluator/calls/iso.yo` (584 lines — `_iso_function_offense`
  :74, `evaluate_iso_type_call` with the Phase H/D2/D9 gates,
  `evaluate_iso_value_call`); dispatch arms at `src/evaluator/exprs/_expr.yo:1153`
  (`BK_ISO`), :1262-1266 (`__yo_iso_*`), :1381-1383 (`__yo_var_*`) and
  `src/evaluator/calls/function.yo:8644-8646`; the `__yo_iso_extract` /
  `__yo_iso_unique` evaluators at `src/evaluator/builtins/rc_fns.yo:247-320`;
  `src/evaluator/builtins/var_fns.yo` (158 lines; its sole consumers are the
  two `Var.*` macros); `IsoValueResult` in `src/evaluator/context.yo:654`;
  the `Arc(Iso)` ban at `src/evaluator/types/struct.yo:238-263`; trait arms
  at `src/evaluator/trait_checking.yo:363`; synthesizer arms
  (`src/evaluator/types/synthesizer.yo:514, :1584-1587`); the `Rc(.IsoT(...))`
  arm and `TypeInfo.Iso` serialization at `src/evaluator/builtins/type_fns.yo:1225-1227`;
  misc arms `property_access.yo:1385`, `begin.yo:3251-3266`
  (`frame_is_isolating`), `utils.yo:2957`, `types/function.yo:5257`,
  `calls/helper.yo:556`, `effects/mutation_summary.yo:851`; the "wrap it in
  Arc/Iso" capture error text at `src/evaluator/utils/closure.yo:851`.
- **Types**: the `TypeValueNode.IsoT` variant (`src/types/definitions.yo:345`) —
  the enum is closed, so its match arms go in `creators.yo` (:172, :313 `t_iso`,
  :616), `tags.yo` (:67, :121 `TIso`), `guards.yo` (:499 `is_iso_type`, :627;
  KEEP `is_atomically_counted_rc_type` :508 — `Arc` and `atomic(ref(...))`
  keep the function, minus its `is_iso_type` disjunct), `string.yo:368`,
  `compatibility.yo:1476-1478`, `substitution.yo:732`, `intern.yo:235`,
  `hierarchy.yo:13`, `utils.yo:286, :369, :1170, :1953, :2113`.
  **KEEP `type_reaches_non_atomic_cell`** (`src/types/utils.yo:1241`): Box
  tracing (`src/codegen/functions/constructors.yo:60`) and the `Acyclic`
  derivation (`src/types/utils.yo:1507`) use it. Only its Iso callers go
  (`iso.yo:323`, `rc_fns.yo:301`).
- **Codegen**: `src/codegen/exprs/iso.yo` (131 lines); its import and the
  dispatch in `src/codegen/exprs/generation.yo:110` and :807-810
  (`is_iso_type_call`), plus the `BF_YO_VAR_*` arm :701; the `IsoTypeInfo`
  registry in `src/codegen/utils/index.yo` (:130, :185-186, :390, :677-697,
  the `.IsoT` arm of `get_type_string` :1747-1751, export :2379);
  `generate_iso_*` in `src/codegen/types/generation.yo`; the deep-walk
  emission `generate_iso_uniqueness_functions`
  (`src/codegen/functions/constructors.yo`, from :876); the
  `iso_types.len() > 0` trace-collection gate (`src/codegen/codegen_c.yo:520-522`);
  arms in `functions/declarations.yo:546`, `exprs/other_fn_call.yo:256, :1470-1474`,
  `exprs/drop_dup.yo:41, 65, 120` and the `is_iso_type` arms :457/:704 (the
  atomic inc/dec arms `Arc` uses are the `is_atomic_reference_struct_type` /
  `is_atomic_reference_enum_type` arms — those STAY), `exprs/async.yo:745,
  :1053, :1072`, `functions/generation.yo:1172`, `types/collection.yo:245,
  :372-375`, `exprs/rc_fns.yo:471`, and the Iso comments in
  `functions/gc_runtime.yo:441, :661, :680`.
- **Env / optimizer**: `mark_function_frames_isolating` + `g_isolating_frame_ids`
  + `frame_is_isolating` (`src/env.yo:5083-5108`) exist solely to keep
  refcounts truthful for the uniqueness walk (they disable the dup/drop
  move-optimizer inside `^v`-using functions) — delete them and their
  callers (`rc_fns.yo:314`, `begin.yo:3266`).
- **Front matter**: `BF_YO_ISO_EXTRACT/UNIQUE/DISPOSE` (`src/expr.yo:158-160`,
  export :1062), `BK_ISO` (`src/expr.yo:379`, export :1053), the LSP keyword
  (`src/lsp/completion.yo:132`), and the `Var` constants
  `BF_YO_VAR_IS_OWNING_RC` / `BF_YO_VAR_HAS_OTHER_ALIASES`
  (`src/expr.yo:280-281`, export :1088) with their dispatch.
- **Prelude surface**: the SAFETY block and `impl(Iso(T), Send/Acyclic)`
  (`std/prelude.yo:10051-10065`), the `extract` impl :10066-10075, the `(^)`
  macro and its export :10076-10132, `TypeInfo.Iso` :8023, `Var`
  :8240-8257, the `Isolation` trait :1052-1056 and `Rc`'s impl of it (:9773).
- **KEEP**: the atomic-RC runtime (`__yo_incr_rc_atomic` /
  `__yo_decr_rc_atomic`, `src/codegen/functions/gc_runtime.yo`) — `Arc` and
  `atomic(ref(...))` share it.

## Part A — remove `Iso(T)`, `^v`, `Var.*`, `Isolation`

Scheduled for v0.2.68, ahead of V2b B8–B11 (maintainer, 2026-10-21; §0.2
and Schedule). No bootstrap gating: this is deletion
only, and nothing outside the feature's own surface references the deleted
names. The §1.3 grep gate must return only the allowlisted historical hits
before the PR is opened.

- **A1 — prelude.** Delete the blocks in §1.3 "Prelude surface". The two open
  prelude slots (`(^)` in the operator set, `Var`) vanish; `Rc.try_unwrap`
  and `Arc.try_unwrap` are the documented replacement and already have tests
  (`tests/rc.test.yo`, `tests/arc.test.yo`). As landed, A1 also takes `^`
  out of the prefix-capable operator set (`_is_prefix_op_token` in
  `src/parser.yo`, the four mirrors in `src/formatter.yo`): the deleted macro
  was its only prefix meaning, so `^` is infix-only (bitwise XOR) again.
- **A2 — evaluator.** Delete `src/evaluator/calls/iso.yo`, `var_fns.yo`, the
  dispatch arms, the `rc_fns.yo` evaluators, `IsoValueResult`, the
  `Arc(Iso)` ban, and the trait/misc arms listed in §1.3. Reword the capture
  error at `closure.yo:851` ("wrap it in Arc/Iso" → `Arc`, or a `Send` value
  after V2b). `Send` derivation loses its one unconditional-by-uniqueness arm
  and becomes purely structural (VALUES_BY_DEFAULT §3.8). Move
  `issues/retired/2026-10-20-an-iso-graph-holding-a-non-send-handle-crosses-threads.md`
  and `issues/retired/2026-10-20-iso-sends-collector-tracked-objects-to-another-thread.md`
  (also accepted until Part A, maintainer 2026-10-21) to `issues/retired/`
  with a line naming the PR, and delete the latter's repro under `issues/repros/`.
- **A3 — types.** Remove `TypeValueNode.IsoT` and every match arm; delete
  `is_iso_type`, `t_iso`, `TIso`. Keep `type_reaches_non_atomic_cell`.
- **A4 — codegen.** Delete the files, registry and arms in §1.3, including
  `generation.yo:110`/:807-810. The `iso_types.len() > 0` condition on trace
  collection goes; nothing else changes for `Arc`.
- **A5 — env / optimizer.** Delete `mark_function_frames_isolating`,
  `g_isolating_frame_ids`, `frame_is_isolating`, and every call that keys on
  them. **This touches the dup/drop optimizer's family: the emit-diff gate
  plus an over-cancellation canary are REQUIRED** (AGENTS.md pitfalls; the
  move optimizer and the isolation frames interact).
- **A6 — tests.** Delete `tests/iso.test.yo` and `tests/iso_api_surface.test.yo`.
  Remove the Iso cases elsewhere, found by the grep gate; the known sites:
  - `tests/parallelism_soundness.test.yo`: the D2 block (:471-494, including
    the `^b` canary at :489), the "D9 inside an Iso" cases (:638-674, the
    `^w`/`^xs` sites :644/:656/:670), and the `^ks` sub-case of the D9
    canary (:773-779). **KEEP every other D9 test** (:526-636 and the rest
    of the canary): D9 is the general function-value `Send` rule and uses
    no `Iso`.
  - `tests/thread_safety.test.yo` (the :251-259 ban pins),
    `tests/send_sync.test.yo` (`^bag` at :246 and :272, plus :237/:280),
    `tests/basic.test.yo` (:533, :692), `tests/explicit_allocators.test.yo`
    (:66-77), `tests/rc.test.yo` (`^x` at :133 and :143).
  - The `IsoT` cases of `tests/internal/types_type_guards.test.yo`,
    `types_guards.test.yo`, `types_string_compat.test.yo`, `types_utils.test.yo`.
  - The `tests/cli-cases/lsp-analysis-resilience` golden loses four
    completion entries: `Iso` (keyword), `Isolation`, `Var` and `^`. Re-record
    with `--record` after reading the GOLDEN-DIFF; nothing else may move.
  - The replacement probe (a `String` and an `ArrayList(String)` moved
    into a spawned thread and back by value) is NOT part of Part A. It
    fails before V2b's B8, and Part A lands first (2026-10-21), so B8 adds
    it as a test and it gates B8 (`plans/VALUES_BY_DEFAULT.md` §6 B8,
    Tier 1).
- **A7 — docs, plans, instructions.** The sweep is a grep gate over
  `docs/`, `plans/`, `.github/`, `README.md`, `AGENTS.md`, `std/`, `src/` and
  `vscode-extension/` (the §1.3 pattern), allowlisting `plans/archive/`,
  `plans/handover/`, `issues/fixed/`, `issues/retired/` and this doc. Known
  sites:
  - Delete `docs/en-US/ISOLATED.md` and `docs/zh-CN/ISOLATED.md`; trim the
    Iso sections of THREAD_SAFETY, ARC, MEMORY_SAFETY, DESIGN ("Isolated
    Types"), PARALLELISM, EXPLICIT_ALLOCATORS, COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS,
    TYPE_REFLECTION and GRAMMAR, in both languages.
  - `plans/VALUES_BY_DEFAULT.md`: :56, :631-637, :892, :4457, :4629,
    :4994-5002 (line numbers on the tree after this plan's own VBD edit) and the later Iso mentions the grep finds; replace the :695
    line "`Iso(T)` / `^v` remain the explicit 'fail if shared' transfer" with
    the Rust-rule statement and a `Rc.try_unwrap` pointer.
  - `plans/reference/PARALLELISM_RULES.md`: **retire D2 in place** (:97-124)
    with a banner ("RETIRED <date>: `Iso` deleted, see
    `plans/backlog/MACRO_AND_ISO_REMOVAL.md`"); delete only D9's Iso bullet
    (:201-205) and D10's Iso sentence (:38-39). **No renumbering**: D-numbers
    are cited across the tree (`git grep -w D9` alone has ~150 hits, and
    code comments such as `src/evaluator/calls/closure_type.yo:329` say
    "Rules D4 + D9").
  - `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` (the `(^) ::` sites :29,
    :56, :128, :131 and the "Iso sugar | `^`" table row :90),
    `plans/reference/MEMORY_SAFETY.md` (:156, :728), `ARC_TYPE.md`,
    `TYPE_REFLECTION.md`; `plans/backlog/LIFETIME_REPLACEMENT_PATTERNS.md`
    (:119, :188), `RUST_REFERENCE_PATTERNS.md` (:739, :878),
    `ARENA_ALLOCATOR_FEASIBILITY.md`, `MULTI_CLOSURE_RC_BUG.md`;
    `plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md`; the ROADMAP's parallelism
    pillar line (:56); and moot follow-up 4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`
    (:830).
  - `.github/instructions/yo-design.instructions.md`: delete the D2 bullet
    (:186), fix the `ref_count` note (:128) and "the GC/`Iso` walk" (:115);
    KEEP the "D4 + D9, function values" bullet (:184).
    `.github/instructions/c-codegen.instructions.md` (:670, the `Iso(T)(v)`
    constructor note); the skill cheatsheet
    `.github/skills/yo-syntax/syntax-cheatsheet.md:1314` (an "Isolated types"
    row linking the deleted `ISOLATED.md`), whose edits change the skill
    goldens while `yo skills install` exists; AGENTS.md if it names Iso.
  - Comments: `std/allocator.yo:290`, `src/codegen/functions/gc_runtime.yo:441/661/680`.
  - The editor grammars: `vscode-extension/syntaxes/yo.tmLanguage.json:149`
    and `yo.vim:80`.

**A — verification (Tier 1).** `yo build --std-path ./std`; `yo check ./src`
and `yo check ./std` (both `--std-path ./std`); the affected test files one
per invocation (parallelism_soundness, thread_safety, send_sync, rc, arc,
basic, explicit_allocators and the four internal types files; the
replacement probe gates B8 instead, A6); `scripts/cli-diff-test.sh` (read every GOLDEN-DIFF — the
LSP golden and the skill goldens are expected to move, nothing else); the
dup/drop emit-diff gate and canary for A5; the §1.3 grep gate; `yo fmt`
(tree binary) on every touched `.yo` and Markdown file;
`scripts/check-issue-refs.sh`.

## Part B — de-macro the remaining constructs (Generation A)

**Principle: each desugar emits exactly the AST the macro emits today.**
This covers B1 and B4. Their call sites keep their spelling (`for(...)` still
parses; the desugar rewrites the call before name resolution, so the std name
stops mattering). B2 and B3 are the exceptions: they delete the surface and
migrate every caller.

**Acceptance gate per desugar** (B1):

- The C emit-diff over the language corpus AND over the compiler's own
  stage-2 C is empty **modulo ExprIds and hidden-local names**. Macro
  `gensym` names are per-(prefix, module) ordinals assigned in evaluation
  order (`src/evaluator/builtins/gensym.yo`); desugar-minted names are
  assigned in parse order, so the two spellings differ. Normalize both
  before diffing, or have the desugar mint the same ordinals.
- The construct's tests pass. "Unchanged" excludes diagnostic text: where a
  diagnostic's wording changes (B1's E0911 help), its cli-case golden is
  re-recorded on purpose, after reading the GOLDEN-DIFF.
- **The macro is never reached for a desugared name.** While the macros are
  retained, a missed desugar fails silently: `desugar_if_calls` returns a
  subtree unchanged unless `_contains_desugar_target` (`src/expr.yo:1748`)
  knows the target (:1867), and the prelude macro then expands the call, so
  the emit-diff reads clean. B1 adds a `for` predicate to
  `_contains_desugar_target`, and adds a debug assertion (or counter,
  `YO_DEBUG_*`) at the macro dispatch
  (`src/evaluator/calls/function.yo:10569` path) that fails when a macro
  named `for` is dispatched. The corpus runs with it on. No
  `unsafe.drop` predicate is needed: B4 has no desugar, its sites call
  `___drop` directly, and the assertion covers `for` only.
- Token synthesis reuses `_synth_desugar_tok` (`src/expr.yo:1212`) and never
  clones `Token.input`: the first `if` desugar did, and cost 4× wall time
  and 2.8× RSS (`issues/desugar-token-clones-evaluator-regression.md`).
  Measure `check ./src` time and peak RSS before and after.

**The retained-macro rule** (the `if` → `cond` precedent, MACRO_POLICY "What
actually landed" item 3): the desugars land in the tree now, but the prelude
macros STAY until a desugar-bearing release is the seed. Three things drive
the retention:

- the seed BUILDS macro calls: `src/`'s six `for` loops (§1.2) and std's
  `unsafe.drop` calls until B4 rewrites them;
- CI and tooling that run test files with the SEED (the #1440 failure mode:
  the FV job runs Generation A test files with the seed, which cannot know a
  tree-side desugar);
- the fallback role: a desugar path missed (odd arity, mismatched labels,
  dynamically built ASTs) degrades to today's behavior instead of breaking,
  which is also why the never-reached assertion above is needed.

Part C deletes the macros.

- **B1 — `for` → `desugar_for_calls`.** Add to the `desugar_if_calls` pass
  family in `src/expr.yo`, hooked at the same choke points (`parse()` in
  `src/parser.yo:1954`, `Evaluator.new` in `src/evaluator/index.yo:169`, the
  derive result splice `src/evaluator/builtins/derive.yo:387`; the macro
  unquote-splice hook at `src/evaluator/calls/function.yo:10584` dies in
  Part C). `generate_expr_from_code` goes through `parse()`, so lowered code
  strings are covered too. The desugar runs AFTER the decision-42 `&mut`
  rewrite (`src/expr.yo:1719-1728`), on the same AST shape the macro
  receives, and reproduces every form the macro handles today:
  - the value form (`coll.into_iter()`, collection moved into the iterator);
  - the read form `for(&coll, x => body)` that V2b's B7 Generation B adds
    (`c := &coll`, `walk_ref`, `x : &T`), with the same guard and E0911
    rules as the borrowed form;
  - the borrowed form `for(&mut coll, x => body)` — decision 39's cursor
    protocol: local borrow for the loop's whole extent, `BorrowedWalk` /
    `walk_elem`, `__borrow_guard` releasing on fall-through/`break`/`return`/
    `unwind`, E0911 for reaching `coll` by name, and the hidden owning local
    for non-place sources via the `__for_source_is_place` structural check
    (port it from the `ExprVal` reflection the macro uses to the parser's
    structural walk);
  - the map form `for(&mut map, (k, v) => body)`;
  - **the loop-invariant hoist**: a body that is a `begin` whose first
    statement is `invariant(...)` has that statement hoisted to the front of
    the generated `while` body (the macro's `has_inv` arm,
    `std/prelude.yo:10792-10818`, R2 task 4; callers
    `tests/spec/fixtures/valid/for_produced.yo`,
    `tests/spec/fixtures/negative/for_produced_false.yo`);
  - the deleted mode-word diagnostics (`mut(x)`/`inout(x)`/`imm(x)` naming
    the sigil spelling and the `borrow-spelling` migration).

  Hidden locals mint fresh ExprIds and synthesized unique names — the
  parser-side equivalent of the macro's `gensym`. `break`/`continue`/`return`
  keep working because the expansion is an ordinary `while` whose body is a
  block containing real `break` AST nodes (`BK_BREAK`, `src/expr.yo:357`) —
  exactly how the `for_await` macro's output worked before its deletion. The protocol
  stays in prelude functions and methods (`walk_*`, `__borrow_guard`,
  `__BorrowGuard`), so decision 43's later retarget of the borrowed `for`
  edits std, not the parser. One semantic note, accepted with the decision:
  rewriting before name resolution means `for` can no longer be shadowed by
  a user function of that name — the same trade the `if` → `cond` desugar
  already made for `if`.

  **E0911 after the desugar.** Today's borrowed-`for` E0911 comes from the
  macro-site rule: `_lb_macro_site_of` (`src/evaluator/utils.yo:5323`)
  fires only when the hidden borrow's declaring token belongs to another
  module than the call, and then makes the borrow live over the whole macro
  call (:6392-6406). A desugar mints tokens in the caller's module, so that
  rule stops firing (VBD:3335 already says so for a macro defined in its
  caller's module), and the ordinary live-range rule must take over. B1
  therefore places the synthesized tokens so that the ordinary rule
  reproduces the macro-site extent:
  - the hidden borrow's declaration takes the `for` call's head token;
  - its last use is a synthesized token at the call's closing token, inside
    the `__yo_borrow_check(c, while(...))` statement whose `end` the live
    range takes through `_last_token_of` (`utils.yo:3888`);
  - every `io.await` inside a desugared loop body carries its own source
    token, so rule 4's across-await check (which today reads
    `LocalBorrowMacroSite.await_ids`, `utils.yo:5343`) sees the awaits
    inside the borrow's live range by position.

  Acceptance: E0911 still fires for the body naming `coll`
  (`tests/cli-cases/borrowed-for-push-same-variable-is-e0911`,
  `tests/for_macro_borrow*.test.yo`) and across an await in a desugared
  loop. B1 rewords the `info.macro_site` help text (`utils.yo:5727`, "the
  borrow lasts for the whole macro call") to name the loop — "the borrow
  lasts for the whole `for` loop" — keyed on a desugar-site marker the
  desugar leaves on the hidden borrow (a flag on its synthesized token, or
  a small registry keyed by the begin node's id). The golden pins
  `for_coll0`, the help text and a second `--> main.yo:6:3` anchor; re-record
  it with the GOLDEN-DIFF read.

  **The verifier.** `src/verifier/vc.yo:4020` dispatches on a source-form
  `for` call (`if(head == "for", …)`), and `_for_term` (:3250) reads the
  macro's recorded expansion (:3287) to find the list-iterator loop
  (`_for_expansion_loop`, :3188) and push the `ForFrame` that `produced(xs)`
  needs (:4069 fails "produced(xs) outside a for over xs"). After the
  desugar the `for` head never reaches the verifier. B1 keeps `_for_term`
  and `produced(xs)` working by recognizing the desugared shape, either:
  - **a desugar-site marker** (preferred): the desugar records (collection
    name, element name, loop node id) for the begin node it emits, and
    `_for_term` keys on that record instead of the `for` head; or
  - **shape recognition**: `_for_term` matches
    `begin(it := xs.into_iter(); while(true, { [invariant(...)]; tmp := it.next(); match(...) }))`
    directly.

  Either way the invariant-hoist form must verify as it does today
  (`for_produced.yo` proves, `for_produced_false.yo` fails).

  **Sequencing with decision 43** (REFERENCES_AND_ORIGINS N3): the borrowed
  `for` gets a new target later — `impl(&C, IntoIterator)` in place of
  `BorrowedWalk` — and VBD §6 "Decision 43" step 4 lands it. B1 is scheduled
  after step 3 settles that protocol, so the lowering is written once.
  `REFERENCES_AND_ORIGINS.md:63` says the borrowed `for` is "unchanged (a
  loop, not a value)"; that is the rule, while its lowering moves at N3.
- **B2 — `for_await`: DELETED 2026-10-24, no desugar** (maintainer decision,
  advisor concurred; as B3 deleted the collection literals). Yo's await is
  not an algebraic effect: a suspension point is an `io.await` written in
  the `io.async` body, and an `io.await` inside a function the task calls
  blocks instead of suspending. `for_await` was pure sugar for the written-out
  loop and the only std construct hiding a suspension point behind a name
  (its whole bug history), so the macro, its export and
  `std/async/stream.yo`'s `pragma(Pragma.AllowMacroDef)` went, with no
  replacement name. Every caller was rewritten to
  `mut(s) := stream; while(true, { n := io.await(s.next(io), io); match(n, .Some(x) => body, .None => { break; }) });`
  (the `mut` is decision 47's: `next` takes `self : &mut Self`; the macro's
  gensym local was std-token and exempt). The two E0911 cli-cases were kept
  as regressions of "a borrow / `mut` match place live across an await in a
  loop" and renamed to
  `local-borrow-across-an-await-in-a-loop-through-a-cell-is-e0911` and
  `mut-match-place-across-an-await-in-a-loop-through-a-cell-is-e0911`; both
  still fire E0911. Record: `plans/reference/ASYNC_ITERATION_STREAM.md`
  ("A `for`-equivalent", verdict 2026-10-24).
- **B3 — replace the collection literals with constructors** (maintainer,
  2026-10-20: Yo is written by LLMs, not humans; terse literals are human
  ergonomics). Delete the three macros AND the call surface — no desugar.
  `array_list(...)`, `hash_map(...)`, `hash_set(...)` become ordinary
  unresolved names (and `hash_map`'s `k => v` argument form, the one
  call-argument shape that is not a valid expression, leaves the language
  with them). Remove the three files' `pragma(Pragma.AllowMacroDef)` lines
  with their macros.
  - **Add Rust-parity consuming constructors**, as ordinary functions:
    `ArrayList(T).from(sink(arr) : Array(T, N))` (Rust's `Vec::from([T; N])`),
    `HashMap(K, V).from(sink(arr) : Array((K, V), N))` and
    `HashSet(T).from(sink(arr) : Array(T, N))`. Elements move out of the
    array; nothing is copied. An `Array` value is spelled
    `Array(i32, 3)(1, 2, 3)` (as in `tests/algebraic_effects.test.yo:993`),
    so a site reads `ArrayList(i32).from(Array(i32, 3)(1, 2, 3))`.
  - **`from_array` is DELETED** (decided 2026-10-20, maintainer-delegated;
    `plans/handover/VBD_RELEASE_SCHEDULE.md` §5 decision 8). The
    existing `ArrayList.from_array(arr : &Array(T, N))`
    (`std/collections/array_list.yo:229`) borrows the array and copies
    each element out of it. That is the implicit copy VBD removes, and it
    becomes E0901 for non-`Copy` elements after V2b's B8 flip. A
    `where(T <: Clone)`-bounded copy would keep a second spelling of what
    `from` plus an explicit clone already says. `Array(T, N)` implements
    `Clone` element-wise (`std/prelude.yo:7315`, `where(T <: Clone)`), so a
    caller that keeps its array writes `ArrayList(T).from(arr.clone())`,
    and one that does not writes `ArrayList(T).from(arr)`, which moves.
    - Callers: **none.** `git grep -n "from_array"` outside `plans/` and
      `issues/` at `fc15a6092` finds only the definition, one comment and
      two goldens. The B3 PR still touches all three:
      - the `src/evaluator/calls/function_type.yo:923` comment names
        `from_array` as its `generic(N : usize)` value-binder example;
        repoint it at `from`, which carries the same binder;
      - the `lsp-completion` and `lsp-member-definition` cli-cases list
        `from_array` as a member, so cli-diff must run and both goldens are
        re-recorded after reading their GOLDEN-DIFF.
  - **Landed (B3, `feat/macro-b3-collection-constructors`).** The three
    callers above were updated (the comment now names `ArrayList.from`; both
    goldens re-recorded). The copying spelling `ArrayList(T).from(arr.clone())`
    was blocked by a pre-existing S2: an inline dot-call argument misbound a
    `generic(N : usize)` binder, so the clone was bound to a local first.
    Fixed 2026-10-22
    (`issues/fixed/2026-10-20-a-usize-generic-binder-is-misbound-from-a-method-call-argument.md`);
    the inline spelling now compiles and the workaround sites were simplified.
  - **As built (B3).** `from` is an inherent static, not a `From` impl: the
    prelude's `From(Source)` takes `value : &Source`, a borrow, so a
    consuming constructor cannot implement it. `ArrayList.from` moves the
    whole array into its buffer with one `__yo_ptr_write` (no per-element
    copy or drop, so a move-only `T` works; that write needed the codegen fix
    in `issues/fixed/2026-10-20-ptr-write-of-an-rc-element-array-emits-invalid-c.md`);
    `HashMap.from`/`HashSet.from` go through it and `pop` each element out in
    array order (a repeated key keeps the last value, as `insert` does). A
    one-element array is `[x,]`: a bare `[x]` is the removed slice-type
    syntax.
  - **Review round (B3, 2026-10-21).** The removal test asserts through the
    module value (`_m.array_list(...)` is `Module field "array_list" not
    found`); an unqualified call cannot tell "deleted" from "not imported",
    and the qualified form fails against a std that still exports the
    macros. The return path had the same element-wise-dup adoption as the
    `__yo_ptr_write` fix (`return(w.a)` of an `Array(String, 2)`, invalid C;
    pre-existing, seed fails too), fixed in
    `issues/fixed/2026-10-21-return-of-an-rc-element-array-emits-invalid-c.md`.
    With the std literals gone, `tests/macro_def_pragma.test.yo` carried a
    local quoted-variadic macro so that path kept runtime coverage until
    Part C. That file was deleted early on 2026-10-24 (C5), so the
    quoted-variadic binding path has no runtime coverage left; it is code
    C2 deletes, and no std code uses `...(quote(` any more. The parser edit is mechanical, but both bootstrap gates this
    section names were run with the tree binary: `gates_fast.sh` rc 0 and
    `fixpoint_only.sh` holds (stage-2 hollow 0, stage 2 == stage 3). The
    compiler's own stage-2 C is byte-identical between the v0.2.67 seed
    (develop's codegen) and the branch compiler, so the codegen guards
    change no site in `src/`. Stage-2 `check src/main.yo` max RSS, develop
    vs branch (same stage-1, two runs each, shared heavy-lock slot):
    1,108,096 / 1,106,952 kB → 1,090,480 / 1,090,192 kB.
  - **Dependency: the fixed-array S2 — resolved.** A fixed-array literal of
    runtime `String`s emitted invalid C; #1496 (`400413ac3`) fixed it
    (`issues/fixed/2026-10-17-a-fixed-array-literal-of-runtime-strings-emits-invalid-c.md`,
    with its test in `tests/array.test.yo`). The migrated sites with runtime
    non-`Copy` elements (`tests/collection_literals.test.yo:44`'s
    `` array_list(`hello`, `world`) ``, `tests/iterator_combinators.test.yo:586`,
    `tests/closure_capture_rc_leak.test.yo:26`) hold direct runtime
    `String`s, so they migrate to `from(Array(...)(...))` as written. The
    nested-field S2
    (`issues/2026-10-20-an-array-or-tuple-literal-whose-element-holds-a-runtime-field-emits-invalid-c.md`)
    does not apply to them; a site whose element is a struct with a runtime
    field uses pushes until it is fixed.
  - **Migrate every caller**: the eight `src/parser.yo` sites (they are
    seed-compiled, and their elements are runtime `AstExpr` values, so they
    use `ArrayList(T).with_capacity(n)` + pushes — an in-tree fix of the S2
    does not reach the seed), the 47 test lines in the four files of §1.2
    (including `tests/codegen-bootstrap/closure_where_clause_param.yo`), and
    anything else the grep `(^|[^_a-zA-Z.])(array_list|hash_map|hash_set)\(`
    finds outside comments.
  - Because the surface goes away in this PR, it MUST run the parse-surface
    escape-hatch checklist from Part C: grep `.github/workflows/` for
    `yo test` steps a SEED runs over files that call the literals and migrate
    those files too, and put the tree binary first on `PATH` for tests
    embedding Yo source in string literals.
  - No emit-diff gate — there is no desugar to prove equivalent; the
    migrated suite is the gate.
- **B4 — `unsafe.drop` → `___drop`.** *Landed on branch
  `refactor/macro-b4-unsafe-drop` (2026-10-20): all twelve std sites — the
  `(^)` body's included, since A1 had not landed and its quoted body would
  otherwise expand to a deleted name — and `owned_buffer.yo` call `___drop`;
  the `unsafe` impl keeps only `cast`; the
  `lsp-analysis-resilience` golden re-recorded, plus
  `check-derive-clone-non-clone-field` and `lsp-member-definition`, which
  cite prelude line numbers the deletion shifted by three.* The original
  instruction, kept for the record: rewrite the eleven std sites
  (§1.2; the twelfth was to die with A1's `(^)` deletion) and
  `tests/fixtures/owned_buffer.yo:50` to call `___drop(...)` directly, then
  delete `unsafe.drop` from the `unsafe` impl (`std/prelude.yo:248`). No
  wrapper and no module-value alias: `___drop` is not a bindable value.
  `BF_DROP` (`src/expr.yo:80`, lexer fast path `src/token.yo:149`) is
  dispatched by the callee atom's spelling (`src/evaluator/exprs/_expr.yo:1250`,
  `src/codegen/exprs/generation.yo:773`, `src/evaluator/exprs/begin.yo:1715`,
  `src/codegen/exprs/drop_dup.yo:872/877`), unlike `__yo_as`, which is a
  declared extern value (`std/prelude.yo:146`, exported at :244; the target of `cast :: __yo_as;`
  at :250). Every site already holds the place the drop needs (`p.*`),
  which is exactly what the macro passed. No generation discipline is
  needed: the seed already lowers `___drop`, and `tests/basic.test.yo` and
  `tests/rc.test.yo` already call it directly. The
  `tests/cli-cases/lsp-analysis-resilience` golden's `unsafe` detail loses
  `drop : fn(value : &Expr) -> Expr`; re-record with the GOLDEN-DIFF read.
- **B5 — the release.** No new release boundary: B5 is decision 43's
  step-2→4 release (Schedule). When that release is the seed (`SEED_VERSION`
  bump), Part C unblocks.

**B — verification (Tier 1).** `yo build --std-path ./std`; both checks; the
construct's tests one per invocation (`tests/for_macro_borrow.test.yo`,
`for_macro_borrow_strict`, `for_macro_borrow_user_collection`, the async
stream/channel tests, the collections suites, `tests/rc.test.yo`,
`tests/arc.test.yo`); for B1, `yo verify ./tests/spec --format json` with the
tree binary, `tests/spec/contracts_phase0.test.yo`, and every
`tests/internal/verifier*.test.yo` file (21 files: one in-process run under
`exclusive`, `YO_TEST_IN_PROCESS=1`, per AGENTS.md's more-than-~8 rule);
`scripts/cli-diff-test.sh` for B1 and B4 (read every GOLDEN-DIFF before
`--record`); the emit-diff gate proving desugar ≡ macro output (B1 only,
modulo ExprIds and hidden-local names, corpus and stage-2 C); the
never-reached assertion; the `check ./src` time and RSS measurement;
`yo fmt` with the tree binary. Full fast suite before merge for B1 (it
touches every `for` in 48 files under `tests/`, 25 of them `*.test.yo`). Bootstrap gates (`gates_fast.sh`,
`fixpoint_only.sh`) since the parser and prelude both changed.

## Part C — delete the macro machinery (Generation B, after B5)

- **C1 — flip the gate to a removal error.** A signature with a quoted
  parameter or an unquote return becomes a hard error **E0010** (the next
  free code in the syntax band on `8203bd867`; E0009 is the
  deleted-spelling code, which has a migration this error lacks). It
  carries a `src/diagnostics.yo` constant, a `src/diagnostics_registry.yo`
  entry with an example and `yo explain E0010` text in both languages, and a
  cli-case modeled on `tests/cli-cases/deleted-borrow-mode-words-are-e0009`.
  The message names this doc. No `yo fix` migration: the only in-tree
  definers are the fixtures C5 rewrites. Re-check that E0010 is still free
  when C1 lands.
- **C2 — delete the machinery.** The §1.1 rows:
  - registries + gate (`types/function.yo`), `is_macro_def_capable_file`
    (`memory_safety.yo:249-262` and its export :401);
  - `Pragma.AllowMacroDef`: the variant (`std/prelude.yo:86`), the map line,
    the AST-shape fast path, and every `pragma(Pragma.AllowMacroDef)` line
    left in std (`std/prelude.yo:137`, `std/async/stream.yo:109`,
    `std/encoding/json.yo:61`) and tests (`tests/async/channel.test.yo:4`).
    Grep the whole tree, including the `markdown_yo` store dependency, and
    fix the comment at `std/prelude.yo:10557`;
  - the dispatch (`MACRO_DISPATCH_ENABLED`, `fv_is_macro`, quoted-arg
    binding, force-execute flags, unquote-return splice);
  - `macro_expand.yo` with its wiring: the dispatch arm
    (`src/evaluator/exprs/_expr.yo:1239-1240`), `BF_MACRO_EXPAND`
    (`src/expr.yo:70` + the `:1057` export list), the lexer fast path
    (`src/token.yo:143`);
  - the macro-site borrow machinery (`g_lb_macro_sites`, `_lb_macro_site_of`,
    `LocalBorrowMacroSite`, `local_borrow_enter/leave_macro_site`). B1
    already moved the help text to its desugar-site marker;
  - the remaining std macro definition (`for` and its export;
    `for_await` was deleted in B2, the literals went in B3, `(^)` and `Var.*` in Part A,
    `unsafe.drop` in B4) and the commented-out `fill` block
    (`std/prelude.yo:7116-7122`);
  - `derive_rule`'s result is restricted to items (§0.1), with a diagnostic
    naming this doc for any other result.

  **Malformed `for` after C.** `desugar_if_calls` has no error
  channel, so a shape the desugar leaves alone would surface as "variable
  `for` not found". C2 adds a dedicated evaluator diagnostic for a `for`
  call the desugar did not rewrite (wrong arity, a handle that
  is not `x => body` or `(k, v) => body`), naming the accepted forms, with a
  cli-case. With C the name is a builtin form: add `for`
  to the LSP keyword list (`src/lsp/completion.yo`) and the editor grammars.
- **C3 — the lowering channel.** The PLANNED outcome is a renamed
  builtin-lowering channel: `ExprInfo.macro_expansion`,
  `g_macro_expansions` and `record_macro_expansion` become, for example,
  `ExprInfo.lowered_to`, `g_lowerings` and `record_lowering`. Its writers
  after Part C are the six non-macro ones of §1.1 — the `Copy` clone
  (`function.yo:937-938`), the structural clone (`closure.yo:1472-1473`),
  the match-arm tests (`match.yo:1427`), the pin channel
  (`initialization_assignment.yo:547, :945`), and the pointer and numeric
  casts (`pointer_type.yo:176-177`, `numeric_type.yo:460-461`). An in-place
  rewrite is not available: a cast replaces the node itself, callee
  included, and codegen walks the original node (`pointer_type.yo:131-139`);
  the auto-deref precedent works only because it overwrites a CHILD slot
  (`property_access.yo:1853`). **The dup/drop emit-diff gate and an
  over-cancellation canary are REQUIRED** for the rename — `begin.yo`'s
  optimizer consults this table — and `src/verifier/vc.yo` (:112, :2773,
  :3287) is renamed with it.
- **C4 — the chase sites, per consumer.** The 25 consumer files of §1.1
  stay on the renamed channel unless a consumer follows it only for macro
  expansions. Decide each consumer separately and record the verdict here:
  codegen emission, the collectors the match-arm tests and the pin channel
  rely on, the dup/drop optimizer, and the verifier (`vc.yo:112`, `:2773`;
  `:3287` moved to B1's desugar-site marker) all keep it. Same emit-diff
  gate.
- **C5 — tests, fixtures, docs.**
  - **Done early, 2026-10-24** (maintainer decision, branch
    `tests/delete-macro-fixtures-early`; the machinery itself stays until C2
    because std's `for` and `unsafe.drop` are still macros the seed expands;
    `for_await` was deleted the same day, B2):
    - deleted `tests/macro_def_pragma.test.yo`, `tests/macro_def_gate.test.yo`,
      `tests/internal/macro_expansion.test.yo`,
      `tests/internal/macro_registry.test.yo` and
      `tests/codegen-bootstrap/try_macro_assign.yo` with its golden;
    - every case of `tests/internal/ast_reflection.test.yo` and the three
      module-source cases of `tests/internal/macro_helpers.test.yo` reached
      the reflection builtins through a gated macro definition. They were
      REWRITTEN, not dropped: each now evaluates `__yo_expr_is_atom`,
      `__yo_expr_is_fn_call`, `__yo_expr_get_callee`/`get_args`,
      `__yo_expr_eq`, `gensym` and the comptime-list `car`/`cdr` over
      `quote(...)` values in module-level comptime bindings, with a negative
      control in each `cond`. The direct `evaluate_gensym` token-sharing case
      and all of `tests/internal/quote_macro_eval.test.yo` were already
      macro-free and stay; the `MACRO_DISPATCH_ENABLED` guards are gone from
      these files, so C2 need not touch them;
    - `macro_def_gate`'s third case ("quote/Expr values stay ungated") pins
      surviving behaviour and moved to `tests/comptime.test.yo`;
    - `macro_def_pragma`'s `comptime_expect_error` pin (a borrow of a
      module-level place live across a user-macro call is E0911) was the
      only guard of "a macro call whose expansion makes a runtime call is
      itself a runtime call" (rule 3). It is replaced by a `for` case in
      `tests/local_borrows.test.yo`
      (`module_level_borrow_across_a_for_loop_rejected`), which Part B's
      desugared loop must keep rejected. Its `local_list` quoted-variadic
      macro was the runtime coverage of the `...(quote(elems))` binding
      path (`src/evaluator/calls/function.yo`, `function_type.yo`); that
      coverage is gone, and C2 deletes the path;
    - CI's `tests/internal` shard map lost its fourth heavy file
      (`.github/workflows/test.yml`), and the docs that named the deleted
      files (`AGENTS.md`, `testing.instructions.md`, `scripts/heavy-lock.sh`,
      DESIGN's `try` note in both languages) were updated.
  - **Still C5's:** rewrite `tests/async/channel.test.yo:417`'s `_recv_one`
    as plain code (the `for_await` import of
    `tests/async/combinators.test.yo:10` went with B2, 2026-10-24); trim the
    gate-path section
    of `tests/internal/memory_safety_paths.test.yo` (it pins the live gate
    until C2); decide the origins-corpus row
    `tests/origins/corpus/macro-ret-local.yo` (a user macro; its manifest row
    is `tests/origins/corpus.tsv` and its model case is in
    `tests/origins/model_corpus.test.yo`) — delete the row once C1 makes the
    definition an error. Comments in `src/`/`std/` still name the deleted
    files (`src/evaluator/builtins/quote.yo`, `src/evaluator/calls/function.yo`'s
    quoted-variadic binding, `std/prelude.yo`'s removed-`try` note,
    `src/README.md`'s macro-test paragraph); C2 deletes or rewrites those
    sites with the machinery.
  - KEEP `tests/for_macro_borrow*.test.yo` (they pin `for` semantics, which
    the desugar preserves). KEEP the formatter fixtures at
    `tests/internal/formatter.test.yo:498/:524`: they are macro SIGNATURES
    (`m :: (fn(...(quote(entries))) -> unquote(Expr))(());`) used as
    formatter-only input, and they survive C1 because the formatter only
    parses.
  - `tests/cli-cases/lsp-analysis-resilience`: `for` stays but changes
    kind (a prelude function becomes a keyword entry, from C2's keyword-list
    addition), and `__for_source_is_place`
    and (if they become private) `__borrow_guard` / `__BorrowGuard` drop
    out; re-record with the GOLDEN-DIFF read.
  - Docs, as grep gates in BOTH languages (`docs/en-US/`, `docs/zh-CN/`),
    each to zero hits outside an allowlist: macro-as-mechanism text
    (`git grep -nP '\bmacros?\b|宏' -- docs`, reviewed by hand, since
    "macro" also names C macros) and `AllowMacroDef`. Known sites: DESIGN's
    macro chapter (en :4541 "Macro functions", zh :4318 "宏函数") rewritten
    as "no macro layer; comptime, builtin forms and quote/reflection are the
    extension mechanisms", and DESIGN's `for` sections (en :1770-1772, :1881,
    :1890); GRAMMAR (:279, the `quote` macro-parameter production);
    ASYNC_AWAIT (:1283, "the loop form (a macro)"); FLOWABILITY (:184);
    MEMORY_SAFETY (:49); COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS (:394-395);
    ERROR_DIAGNOSTICS (:112, :118, :286).
  - Instructions and skills: the AGENTS.md "Macros kept but gated" bullet;
    `.github/instructions/yo-syntax.instructions.md:275` and the macro rules
    in `yo-design.instructions.md`; the skill cheatsheet
    (`.github/skills/yo-syntax/syntax-cheatsheet.md:84`, and :1595-1596,
    whose claim that `derive_rule` needs the pragma is already stale) and
    the skill goldens that hash it.
  - Plans: close `LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3 as rejected; note
    in `RUST_ADOPTION_CANDIDATES.md` L7 that `matches(x, p)`, if ever
    wanted, is a desugar/builtin — not a macro.
- **C6 — records.**
  - **KEEP the nested-eval issue open**
    (`issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`):
    its remaining fragility is a nested `evaluate_expression_raw` inside a
    DERIVE-generated body, and derive stays. Retitle it without "macro".
  - **The `FnOnce`-twice S2**
    (`issues/a-macro-that-duplicates-an-fnonce-call-calls-it-twice.md`) is
    retired only with evidence that no AST-duplicating path is left: a probe
    showing that neither a derive rule nor a comptime `Expr` splice can
    place one user argument twice, and that the B1 desugar never
    duplicate a user subexpression. Better, fix it as its own doc proposes
    (key the exemption on the call NODE, not its token) with its reproducer
    as a test, and move it to `issues/fixed/`. Update
    `plans/VALUES_BY_DEFAULT.md:43-45`, which lists it as decision 37's open
    S2.
  - `git mv plans/reference/MACRO_POLICY.md plans/archive/` with a
    supersession banner naming this doc; update `plans/README.md` and every
    `grep -rn "MACRO_POLICY"` reference.
- **C — escape-hatch checklist** (a parse-surface change outside `src/`/`std/`):
  grep `.github/workflows/` for `AllowMacroDef` and quoted-param signatures
  (the census found none — re-verify), run `scripts/check-embedded-yo.sh`,
  and put the tree binary first on `PATH` for tests embedding Yo source in
  string literals.

**C — verification.** Full Tier 1; the fast suite; `yo test ./std`;
`tests/internal` one file per invocation for the rewritten files, plus every
`tests/internal/verifier*.test.yo` file (one in-process run under
`exclusive`) and `yo verify ./tests/spec --format json`
for C3/C4; `scripts/cli-diff-test.sh` (the E0010 case, the malformed-`for`
case, the LSP golden, the skill goldens; read every GOLDEN-DIFF);
`scripts/bootstrap/hollow_sweep69.sh` (every language test through the
self-hosted binary — the widest parse-surface sweep available);
`fixpoint_only.sh`; the dup/drop emit-diff gate and canary for C3; the docs
grep gates; fmt and `check-issue-refs.sh`.

## Schedule

Inside the VBD campaign (`plans/VALUES_BY_DEFAULT.md` §6), with no release
of its own:

- **Part A** lands in v0.2.68, pulled forward on 2026-10-21 (§0.2): before
  V2b's B8–B11 (the `String` and collection flips to `Send`-by-move, VBD §6
  V2), which were its original predecessors. From v0.2.68 until B8
  (v0.2.70) no `String` or collection crosses a thread, and the replacement
  probe gates B8. It must precede:
  - V2c (decision 17): otherwise `Iso` handles need a clone story;
  - decision 46's collector-predicate follow-up (VBD §6 "Decision 46" step
    3; the 2026-10-17 handover's step 9): otherwise the narrowed collector
    must keep `Iso`'s traversals complete;
  - decision 43 step 2 (Generation A, references in user code): step 2
    keeps the storage wall and step 3 (N2) is where references reach fields
    and could widen the `Send` hole of §0.2, so preceding step 2 is the
    stricter ordering;
  - V5: the Iso tests use `ref(struct)`.

  Part A needs no release boundary: it is deletion only.
- **B3 and B4** can land any time; neither depends on another phase.
- **B1** lands after decision 43 step 3 (N2, first-class storage)
  settles the borrowed-`for` protocol (`BorrowedWalk` versus
  `impl(&C, IntoIterator)`, REFERENCES_AND_ORIGINS N3; the protocol
  itself lands in step 4). The protocol stays in prelude functions, so the
  parser's lowering is written once.
- **B5** is decision 43's step-2→4 release: no new release.
- **Part C** rides with decision 43 step 4's Generation B (or with V5's
  boundary, whichever comes first after B5's release is the seed).

Within the plan: A (one PR, or A1-A5 + A6/A7 split); B3 and B4 (one PR
each, any time); B1 (the only large one; B2 was a deletion, landed 2026-10-24); B5; C1+C2 → C3 →
C4-C6. Heavy steps (`yo build`, `tests/internal`, the sweeps) take a
machine-wide heavy-lock slot. Every PR follows `.github/pull_request_template.md`
and merges on its Tier 1; develop's battery covers the rest.
