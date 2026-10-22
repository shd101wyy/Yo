# Comptime-only metaprogramming — the audit, the additions, and the Lisp proof

**Status:** WRITTEN 2026-10-22, backlog (written, not started). The full audit
of Yo's comptime support, asked for when the macro removal was decided
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md`, Parts A–C): with the macro layer
gone, is comptime-only metaprogramming enough? The document holds (§0) the
verdict, (§1) the audit of what comptime is today, (§2) what the macro removal
actually removes and what covers it, (§3) the proposed additions to the
comptime context — builtin functions and comptime-only builtin types — and
(§4) the demonstration that exercises all of it: a Lisp interpreter, with Lisp
macros of its own, running entirely inside Yo's comptime context, so that a
broken Lisp program fails the Yo build.

**Written against the post-VBD end state** (`plans/VALUES_BY_DEFAULT.md`
complete): every declared type is a value, runtime copies are explicit
(`.clone()`), bindings are immutable unless `mut(...)`-marked, sharing is
`Rc(T)`/`Arc(T)`, references are first-class with origins at runtime, and the
macro machinery is deleted (the `if`/`for`/`for_await` spellings remain, as
builtin parse-time desugars). Every Yo example below uses post-VBD spellings.
None of the additions reopen a VBD decision; §5 states the only couplings
(spelling, and the `Comptime` auto-derivation, which exists today).

Anchors are on develop `95162303d` (2026-10-22), after #1544. Expect drift;
each item re-runs its greps at execution time. Supersedes
`plans/backlog/UNIFIED_COMPTIME_DESIGN.md` (§6 explains why it is stale).

## 0. The question, and the verdict

The maintainer's question: *we are removing the macro layer and keeping only
comptime — does that limit Yo's metaprogramming?*

**Verdict: no capability Yo wants is lost, and the audit found that the
comptime context itself is under-equipped in concrete, fixable ways.** The
macro layer's four "irreducible powers" (`plans/reference/MACRO_POLICY.md`
§1.5) each have a landed or scheduled replacement, and none of the nine live
std macros' jobs returns as a user need:

| Macro-only power | Post-removal coverage |
| --- | --- |
| Auto-splice at the call site | Builtin desugars (`if`→`cond` since 2026-08-21; `for`/`for_await` in B1/B2); `derive_rule` for items; `comptime_eval` for declarations from strings |
| Introducing bindings into caller scope | The desugars mint hidden locals in the parser (B1); no user-facing construct needs it |
| Caller-frame control flow (`try`'s early return) | Deleted 2026-08-21 (policy §3.1); effects and `Result` are the answer |
| Reifying a caller lvalue's identity (`Var.*`, `^`) | Deleted with `Iso` (Part A); `Rc.try_unwrap` is the bridge |

The one genuine capability delta, stated plainly: **user-defined ad-hoc
expression splicing no longer exists.** A custom lazy-branch construct (an
`unless` that evaluates a branch only when taken) cannot be written as a
function — parameters evaluate — and can no longer be a macro. It must be
`cond`, or a language form somebody adds as a builtin desugar. That is the
deliberate trade of a language authored by LLMs with a closed, greppable form
set (`MACRO_AND_ISO_REMOVAL.md` §0.1), and this plan does not reopen it.
Everything else metaprogramming means — deriving impls, computing types,
embedding and querying data at compile time, generating domain code — is
comptime work.

What the audit *did* find: the comptime context grew around one heavy consumer
(`derive`) and three narrow ones (the type layer, `build.yo`, embedded data).
Its gaps were tolerable in that world. With comptime as the only extension
mechanism, closing them is the campaign: string building is slow and has no
interpolation (§1.9 G1), the only comptime container is a cons list (G2),
AST values can be inspected but not constructed (G3), `comptime_fn` promotion
covers integer/float functions only (G4), and `comptime_int` is an `i64`
pattern — `u64.MAX` folds to `-1` at compile time (G5). §3 proposes the
closures; §4 is the proof they are enough — a Lisp with its own macro system
needs none of the deleted machinery.

Two design invariants carry over from the removal decision and govern
everything here:

- **Exprs are data; two doors make code.** Constructing or rewriting an `Expr`
  is inert. An `Expr` becomes code through exactly `derive_rule` (items only,
  C2's restriction) and `comptime_eval` (strings). No addition may open a
  third door, least of all a general expression splice.
- **The comptime context has no runtime storage.** Comptime values are folded
  compiler values; VBD's runtime ownership story (moves, explicit copies,
  borrow checking) does not apply inside it, and post-VBD value semantics fit
  it unchanged — a comptime aggregate was always copied structurally, which is
  what "everything is a value" says at runtime too.

## 1. What comptime is today (the audit)

Four layers, then the gap table. Line anchors are on `95162303d`.

### 1.1 The value layer

- **Comptime scalars**: `comptime_int`, `comptime_float`, `comptime_str`
  (`src/types/definitions.yo:344-346`, guards `src/types/guards.yo:248-259`),
  coercing to `i32`/`f64`/`str` at runtime positions
  (`src/types/env_lookup.yo:593-618`). `comptime_int` is an `i64` bit pattern
  (G5).
- **The `Comptime` marker trait** (`std/prelude.yo:42-48`, twin `Runtime`
  :49-55) decides evaluability three ways: a tag fast path
  (`src/evaluator/trait_checking.yo:342-388`), auto-derivation at type
  declaration — a value struct/enum/tuple is `Comptime` iff every field is
  (`src/evaluator/types/utils.yo:180-183`) — and on-demand re-derivation for
  `where(T <: Comptime)` checks (:1537-1633). `str`, `Type`, `Expr`, bool,
  every fixed-width integer, pointers to `Comptime` payloads, `Array`,
  `ComptimeList(T)`, `Option`/`Result` over comptime parts, and
  `ComptimeValue` are comptime; reference-semantics types (`ref struct`,
  `String`, `Rc`, `Dyn`), unions, `void` and the C-compat types never are
  (`type_prohibits_comptime_modifier`, `src/types/utils.yo:281-298`). Post-VBD
  this reads cleanly: value types are comptime iff their parts are; shared
  handles never are (a shared handle is runtime storage).
- **The `Comptime*` operator twins**: `ComptimeAdd` … `ComptimeBitXor`,
  `ComptimeNegate`/`LogicalNot`/`BitNot`, `ComptimeEq`/`ComptimeOrd`,
  `ComptimeIndex`, the two `ComptimeRange*` traits and `ComptimeToString`
  (`std/prelude.yo:429-1054`), each a thin impl over an
  `__yo_comptime_<ty>_<op>` intrinsic dispatched by prefix
  (`src/evaluator/exprs/_expr.yo:483-509`).

### 1.2 The signature layer

`comptime(...)` is signature *metadata*, not a type: a `comptime(x) : T`
parameter registers in `g_func_param_comptime`
(`src/evaluator/types/function.yo:333-398`); a `-> comptime(T)` return sets
`result_is_comptime_only` (:4205-4219), which is what routes a call to CTFE.
`generic(...)`/`using(...)` parameters are comptime by default (:1558-1565).
Type constructors are ordinary comptime functions
(`fn(comptime(T) : Type) -> comptime(Type)`; kind ladder `Type(0)`/`Type(1)`,
`src/types/definitions.yo:359-360`), `_` partial application works for any
comptime-returning callee (`src/evaluator/calls/function.yo:8772-8859`), and
HKT parameters take the comptime-function type as a kind
(`plans/reference/HIGHER_KINDED_TYPES.md`).

### 1.3 The CTFE engine

`evaluate_comptime_fn_call` (`src/evaluator/calls/comptime_fn.yo:655-1493`)
executes the body as ordinary Yo under `force_compile_time_bindings`, with a
global memo keyed by func id (:1032-1107), a recursive-placeholder scheme for
type-level recursion (:627-647), and per-call stamping of instantiated names
(:1264-1447). Inside it:

- **Mutable comptime state**: `mut(x) :: v` and `comptime(mut(x)) := v`
  (decision 47), writes gated by E0917/E0918
  (`src/evaluator/exprs/initialization_assignment.yo:1013-1033`,
  `exprs/assignment.yo:401-432`); runtime declarations inside a comptime body
  are E1104.
- **Loops**: `while(comptime(cond), body)` unrolls with a 10 000-iteration
  fuel cap (`YO_MAX_COMPTIME_LOOP_ITERATIONS` overrides;
  `src/evaluator/exprs/while.yo:54-88`); recursion is the other loop form
  (`__yo_comptime_fold_range`, `std/prelude.yo:8541-8555`).
- **Failure**: a `__yo_panic` reached by live CTFE is the compile error
  `compile-time panic: <msg>` (`src/evaluator/builtins/panic.yo:177-201`);
  contracts (`requires`/`ensures`) are checked during CTFE
  (`tests/comptime.test.yo:3390-3402`); integer overflow, `/` by zero and
  friends are compile errors.
- **Who may run at comptime** — three tiers: (1) the `__yo_comptime_*`
  intrinsics; (2) any function with a comptime signature, executed on demand;
  (3) promotion of a runtime function through `comptime_fn(f)` or an implicit
  nested-call site, gated by a capability analysis
  (`src/evaluator/ctfe/ctfe_analysis.yo:393-511`) that trial-evaluates the
  body and mints a comptime clone. Tier 3 promotes **integer and float
  signatures only** (`_to_comptime_type`, `ctfe_analysis.yo:67-79`, whose own
  doc comment names "structs, pointers, bools" as unpromotable) — G4.
- **Budgets**: loop fuel plus a cooperative wall-clock deadline
  (`--compile-timeout-ms`, checked every 16 384 dispatches,
  `src/evaluator/exprs/_expr.yo:510-599`). No explicit budget API (G7).

### 1.4 Compile-time I/O and data builtins

`comptime_print` (`src/evaluator/builtins/comptime_print.yo`),
`comptime_read_file` — Zig's `@embedFile`, package-root-sandboxed and a build
input edge (`builtins/comptime_read_file.yo:95-207`),
`comptime_json_parse`/`comptime_toml_parse` → `ComptimeValue`
(`builtins/comptime_data.yo`), `comptime_assert`,
`comptime_expect_error` (side-effect-rolling-back),
`comptime_eval(code : comptime_str) -> unit` — parse and evaluate Yo source in
the current env (`builtins/type_fns.yo:1402-1496`) — and `comptime_fn`.
`ComptimeValue` (`std/prelude.yo:7707+`) is the document tree: scalars plus
`List(items : ComptimeList(Self))` and `Table(keys, values)` as parallel
lists, with lookup a self-recursive linear scan (`_comptime_table_lookup`,
:7684-7698). User docs: `docs/en-US/CTFE.md`, `docs/zh-CN/CTFE.md`.

### 1.5 The AST layer (quote/Expr)

`quote(...)` returns an `Expr` (`src/evaluator/builtins/quote.yo:233-269`);
`unquote` splices a value's `Expr` in with fresh ids (:82-139) and
`unquote_splicing` a `ComptimeList(Expr)` into a call's argument list
(:152-221). `AstExpr` is `Atom(id, token) | FnCall(id, func, args, is_infix,
token)` (`src/expr.yo:399-408`) — every node carries a full token with row,
column and module path, but none of that is user-visible (part of G3). The
complete user surface is six builtins
(`src/evaluator/builtins/expr_fns.yo`): `__yo_expr_is_atom`, `is_fn_call`,
`get_callee`, `get_args`, `to_string`, `eq` — wrapped as `Expr` methods at
`std/prelude.yo:7786-7807` — plus `gensym(prefix)` minting a fresh identifier
`Expr` (`builtins/gensym.yo:30-149`), `clone_expr_fresh_ids`
(`src/expr.yo:480-502`), and `__yo_comptime_string_to_expr(code)` — parse a
comptime string into an `Expr` (`type_fns.yo:1499-1582`), the engine behind
`TypeFieldInfo.to_expr`. **There is no constructor**: an `Expr` can only be
quoted, parsed from a string, or `gensym`'d, so every conditional construction
(build a call only when…) round-trips through strings (G3).

### 1.6 Type reflection

`TypeInfo` (30+ variants with metadata structs `TypeFieldInfo`,
`VariantInfo`, `FunctionInfo`, …; `std/prelude.yo:7856-8201`) through
`Type.get_info`/`get_struct_fields`/`get_enum_variants`, plus
`Type.eq`/`is_compatible_with`/`impls`/`contains_rc_type`/`can_form_rc_cycle`/
`to_comptime_string`, the derive workhorses `Type.join_fields`/`map_variants`
(`__yo_type_*` builtins, `src/evaluator/builtins/type_fns.yo`), and
`size_of`/`align_of`/`type_of`/`type_id`. Method reflection does not exist
(no `Type.methods`; G9). Contract: `docs/en-US/TYPE_REFLECTION.md`.

### 1.7 `derive`

Ten self-hosted derives (`Eq`, `Hash`, `Clone`, `Copy`, `Ord`, `Default`,
`ToString`, `Debug`, `Error`, `ToJson`/`FromJson`), each an ordinary comptime
function `fn(comptime(T) : Type, comptime(ctx) : DeriveContext,
comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)`
(`std/prelude.yo:8569+`), registered for user traits by `derive_rule`
(`src/evaluator/builtins/derive_rule.yo`) with `DeriveContext.make_impl`
building the `impl(...)` by quote/unquote (:8506-8534). The returned `Expr` is
evaluated in the caller's env (`builtins/derive.yo:359-411`); C2 of the macro
removal restricts that result to items. Generic and `where`-clamped derives
work (`tests/derive.test.yo:382`). This — not the macro layer — is Yo's
metaprogramming success story, and every addition here must keep it
comfortable.

### 1.8 The build file is a comptime program

`build.yo` is evaluated in-process by the compiler's evaluator
(`src/build_runner.yo:3209-3256`); `std/build.yo` is all-comptime over 26
`__yo_build_*` builtins (`src/evaluator/builtins/build.yo:26-52`). It is the
largest existing proof that comptime Yo orchestrates real work.

### 1.9 The gaps

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | Comptime string building is `+` chains over `__yo_comptime_string_concat`; a four-piece chain is commented out with "FIXME: … takes super long time"; no interpolation at comptime (template strings are runtime-only `String`) | `tests/comptime.test.yo:2856-2861`; the `__s2`–`__s5` helpers `std/prelude.yo:8557-8570` |
| G2 | `ComptimeList(T)` is the only container; no map — `ComptimeValue.Table` is parallel lists with an O(n) recursive scan; mutually recursive value shapes are inexpressible, so even a `ComptimeEntry` struct is rejected | `std/prelude.yo:7676-7698` (the doc comment says why) |
| G3 | `Expr` values can be inspected but not constructed; no atom-text/kind query, no infix flag, no token/position exposure; string round-trip is the only conditional construction path; `__yo_expr_to_string` → `__yo_comptime_string_to_expr` round-trip is untested | §1.5 |
| G4 | `comptime_fn` promotion covers integer/float signatures only — not `bool`, `str`, or comptime-struct/tuple/array signatures, so "one spelling, both worlds" (CTFE.md's headline) holds only for arithmetic | `src/evaluator/ctfe/ctfe_analysis.yo:67-79` |
| G5 | `comptime_int` is an `i64` pattern: `u64.MAX` folds to `-1`; unsigned division/compare above `i64.MAX` needed per-type fixes and the overflow check is on the `i64` value | `plans/backlog/ZIG_ADOPTION_CANDIDATES.md` Z3 |
| G6 | No `source_location()` — comptime diagnostics and generated code cannot cite where they came from; `comptime_assert` messages are closed strings | no such builtin (`src/expr.yo` BF_ list); Z4 |
| G7 | No explicit CTFE budget API; the knobs are env/flag only (fuel 10 000, wall clock) | §1.3; Z8 |
| G8 | No comptime iteration sugar: walking a `ComptimeList` or a type's fields inside a body hand-rolls recursion (`__yo_comptime_fold_range`) or a `while(comptime(...))` cursor; whether `for` over a `ComptimeList` unrolls is unverified (post-B1 it desugars through `into_iter`, which `ComptimeList` lacks) | Z7 (verify-first) |
| G9 | No method reflection (`Type.methods`); no consumer exists today | §1.6 |

Not gaps, recorded so they are not re-proposed: `unwrap` at comptime is
deliberately spelled `comptime_unwrap` (safe mode's class-1 ban); async,
extern C calls and runtime allocation are correctly outside CTFE; `Expr`
equality being structural-with-fresh-ids is the invariant that makes unquote
splicing safe.

## 2. What the macro removal removes, and what covers it

§0's table is the summary; this section records the honest accounting.

**The macro-specific machinery goes** (Part C): the two signature flags, the
func-id registries, `Pragma.AllowMacroDef`, the call dispatch,
`macro_expand`, the macro-site borrow rule. **The chase pattern mostly
stays**: six non-macro lowerings write the `macro_expansion` channel, so it is
renamed and survives (C3 of the removal plan), and its consumers keep
following it. The saving is the macro machinery, not the chase sites — the
removal plan says this itself (§0.1), and this audit adds nothing to that
bill.

**What survive untouched**: `quote`, `unquote` inside quoted code,
`unquote_splicing`, `gensym`, `Expr`/`ExprList`, `clone_expr_fresh_ids`, the
`__yo_expr_*` reflection builtins, and all of `derive` (removal plan §0.1).
In other words, the AST *manipulation* layer was never the macro layer; only
the AST *splicing* layer was. Post-removal, an `Expr` reaches code through
`derive_rule` (items, restricted) or `comptime_eval` (strings) — the two
doors.

**The Lisp observation that closes the question.** A Lisp macro system is the
historical proof that macros are "programs over programs". But every Lisp
implementation is itself just an interpreter — data structures and recursion —
running inside some host. Yo's comptime can host one entirely (§4): the
reader, the evaluator, the environments, and the Lisp-level `defmacro` are
comptime functions over comptime data. The guest language gets macros without
the host ever needing them. If a user's metaprogramming need is "a language
with new forms", comptime Yo can be that language's implementation, checked
during the build.

## 3. The additions to the comptime context

Ordered by value below (§5 has the table). Sizes are S (< a day), M (days),
L (a week+). Every prelude/std surface addition follows the seed discipline:
the evaluator builtin lands first (Generation A users call `__yo_*` directly
or through a test), the std wrapper lands once `SEED_VERSION` carries it (the
`std/build.yo` rule of AGENTS.md, generalized).

### C1 — Comptime template strings and fast concatenation (M)

**Close G1.** In a comptime context — a `-> comptime(...)` body, a comptime
binding's initializer, a `comptime(...)` argument — a template string
`` `text ${expr}` `` evaluates to a `comptime_str` with its interpolations
folded, instead of building a runtime `String`. Interpolands are
comptime-known values rendered through `ComptimeToString`
(`comptime_int`/`float`/`str`/`bool` today; anything else must spell
`.to_comptime_string()` explicitly, matching runtime `ToString` discipline).
Interpolating an unknown value is the existing "runtime argument to
compile-time parameter" error. At runtime, template strings are unchanged.

The same item fixes the concatenation cost: `__yo_comptime_string_concat`
walks per `+` (the `tests/comptime.test.yo:2856` FIXME); the fix is a
left-associated chain folding into one builder pass. Gate: that FIXME's
four-piece assert un-commented and green, and the prelude's `__s2`–`__s5`
helpers (`std/prelude.yo:8557-8570`) rewritten to interpolation once the seed
carries the feature (their callers are the derive rules).

No new syntax — it makes an existing literal do the comptime thing in the
comptime place. The alternative (a `format` builtin) is rejected: two
spellings for one operation.

### C2 — A comptime map (M)

**Close G2.** A `ComptimeStringMap(V)` comptime-only type: parallel
`ComptimeList(comptime_str)`/`ComptimeList(V)` fields (the shape
`ComptimeValue.Table` already legitimizes) with construction from a comptime
list of pairs, and lookup through one builtin,
`__yo_comptime_string_map_get(map, key) -> Option(V)`, executed in compiler
code — a linear scan in the fast case, binary search over a sorted copy when
the table is built large. Written-in-Yo lookup (`_comptime_table_lookup`
style) is rejected as the interface: every element fetch is an AST walk.

General `ComptimeMap(K, V)` (any comptime `K` with `ComptimeEq`) is a
follow-on, not the first cut — strings are every real key today (symbol
tables, embed-file indexes, generated-code registries). The runtime-consumable
static map (Zig's `StaticStringMap` — a comptime-built structure that lowers
to efficient runtime data) is Z14's other half and stays there; this item is
the comptime-context half. Recursion-depth note: a map built by fold over a
`ComptimeList` is depth-proportional; construction iteratively over
`while(comptime(...))` with `comptime(mut(m))` avoids the evaluator stack.

### C3 — The AST construction and provenance layer (M)

**Close G3 and G6's Expr half.** Additions to the `Expr` surface, all
comptime:

- Queries: `Expr.atom_text(e) -> comptime_str` (the token's text; error on a
  call node), `Expr.atom_kind(e) -> AtomKind` with
  `AtomKind :: enum(Ident, Int, Float, Str, Rune, Other)`, and
  `Expr.is_infix(e) -> bool`. Together these end the
  `__yo_expr_eq(get_callee(e), quote(+))` idiom
  (`tests/internal/ast_reflection.test.yo:196`) that identifies an operator by
  quoting another one.
- Constructors: `Expr.make_atom(text) -> Expr` and
  `Expr.make_call(callee, args : ComptimeList(Expr)) -> Expr`, minting fresh
  ids (`clone_expr_fresh_ids` discipline) and synthesized tokens in the
  constructing module. Conditional construction no longer round-trips through
  strings. `make_infix(op, lhs, rhs)` is sugar over `make_call` if the fmt
  round-trip needs it — decide at implementation.
- Provenance: `Expr.location(e) -> Option(SourceLocation)` exposing the head
  token's file, row and column, with
  `SourceLocation :: struct(file : comptime_str, row : u32, column : u32)` a
  prelude comptime-only struct (shared with C6).

The two-door invariant is unchanged and testable: nothing here evaluates an
`Expr`; a property test pins
`string_to_expr(expr.to_string(e)) == e` (modulo ids) for the round trip, and
derive rules migrate to constructors opportunistically (the string-building
arm of `__derive_default`'s index trick, `std/prelude.yo:9072-9086`, is the
first beneficiary — it exists because `to_comptime_string` of an instantiated
generic renders placeholders; constructors sidestep rendering entirely).

### C4 — Widen CTFE promotion to every comptime signature (M)

**Close G4.** `_to_comptime_type` (`src/evaluator/ctfe/ctfe_analysis.yo:67-79`)
today promotes `Int`/`Usize`/`Isize` → `comptime_int` and floats →
`comptime_float`, nothing else. Extend it to: `bool` (it is already a comptime
value type), `str` → `comptime_str`, and every type the existing `Comptime`
auto-derivation already blesses — comptime value structs, tuples, fixed
arrays, `Option`/`Result` of promotable parts — reusing §1.1's field rules so
there is exactly one definition of "comptime-shaped". Then `comptime_fn(f)`
works for `fn(a : Point, b : Point) -> bool`, and CTFE.md's "one spelling,
both worlds" claim becomes true for more than arithmetic. The capability
analysis itself (trial-evaluate, mint a clone) is unchanged; only the
signature gate widens.

### C5 — Arbitrary-precision `comptime_int` (M, correctness)

**Close G5.** Adopt Z3 (its verdict: a soundness fix). Representation is
internal to the compiler (an arbitrary-precision integer in the compiler's own
runtime — reuse `std`'s big-integer support if it exists, else add an internal
one; not new surface). Rules: comptime arithmetic is exact and cannot
overflow; narrowing to a fixed width keeps today's range errors (now checking
the true value); the `u64`-above-`i64.MAX` special cases
(`tests/comptime.test.yo:3408-3504`) keep passing because unsigned semantics
are now derived from the value, not patched per type. Measure `check ./src`
CTFE time before and after (Z3's own instruction).

### C6 — `source_location()` (S)

**Close G6.** Adopt Z4: a builtin `source_location() -> SourceLocation`
(prelude comptime struct of §C3) carrying the calling module, row and column.
First users: `comptime_assert` messages, generated-code diagnostics, and the
Lisp interpreter's error attribution (§4). Small, no dependencies, land first.

### C7 — CTFE budget API (S, low priority)

**Close G7.** Adopt Z8: a default per-eval branch quota with
`comptime_budget(n)` for the sites that legitimately need more (a table
generator, the Lisp interpreter's evaluator). We already have fuel and a wall
clock; this makes the limit nameable at the site that raises it instead of an
env var. Not blocking anything; land with whichever C item first trips the
fuel cap in a test.

### C8 — `comptime_for` (S, verify first)

**Close G8.** Adopt Z7: `comptime_for(xs, x => body)` — unrolled iteration
over a `ComptimeList` (and, as sugar over `TypeInfo`, a type's fields),
desugared at parse time to an unrolled `begin`, inside comptime and runtime
bodies alike. Verify-first per Z7: if plain `for` over a `ComptimeList`
already unrolls after B1, document that instead and add only the fields
sugar. Size cap: unrolling mints a body per element; a wide list times a fat
body explodes the AST, so the desugar counts and fails loudly past a bound
(the fuel precedent).

### C9 — Method reflection (parked)

**G9 stays parked**: no `Type.methods` until a consumer exists — dead surface
is not stable (the std rule). The first consumer is likely a wrapper-generating
derive; file it then, with the consumer.

### Rejected, with reasons

- **A general `Expr` splice builtin** (evaluate an `Expr` at the current
  site): that is the macro layer's unquote return, deleted by decision; it
  reopens statement metaprogramming and the expansion chase. The two doors
  stay.
- **`format`-style builtin strings**: one spelling — template strings (C1).
- **Comptime `HashMap`/runtime containers in CTFE**: comptime values have no
  storage; `ComptimeStringMap` (C2) is the comptime shape.
- **`macro_expand` revival**: no user call sites even today (removal plan
  §1.1); `comptime_eval` covers the string path.

## 4. The proof: a Lisp interpreter in the comptime context

**Deliverable: `tests/comptime_lisp.test.yo`** — a self-contained test file
holding a small Scheme-flavoured Lisp whose reader, evaluator, environments
and macro system are comptime Yo, plus the assertions that prove it. A test
file is the venue (the repo has no examples/ tree; `tests/` is where language
capability is demonstrated and gated). The point it proves: **a guest language
with macros of its own needs no host macros** — and a broken Lisp program
fails the *Yo build*, which is what "comptime-only metaprogramming" buys.

### 4.1 The shape

Data (all comptime; recursion goes through `ComptimeList`, the
`ComptimeValue` precedent for why direct `Self` payloads are inexpressible):

```yo ignore
// A Lisp value. Pair-as-list: (.List(head-tail)) or flat items — the reader
// decides; the interpreter treats a 2-element list as a cons cell.
Lisp :: enum(
  Num(v : comptime_int),
  Str(v : comptime_str),
  Sym(v : comptime_str),
  Nil,
  List(items : ComptimeList(Self))
);
LispClosure :: struct(
  params : ComptimeList(comptime_str),
  body : Lisp,
  env : LispEnv
);
LispEnv :: struct(bindings : ComptimeList(LispBinding));
LispBinding :: struct(name : comptime_str, value : Lisp);
```

Phases, each landing green before the next:

- **P1 — the reader.** `read(src : comptime_str) -> Lisp`: a
  `while(comptime(...))` tokenizer over byte slices (`.len()`, `.slice()`,
  comparisons — all existing comptime string ops), then recursive descent to
  S-expressions. Exercises G1 directly: the reader is the string-heavy stage
  that made the four-concat FIXME; it lands before C1 and its timing is
  recorded, then re-measured after C1 as that item's second gate.
- **P2 — the evaluator.** `eval(e : Lisp, env : LispEnv) -> Lisp`, a comptime
  fn matching on the head symbol: `quote`, `if`, `lambda` (closures are the
  `LispClosure` data above — no host fn values involved), `let`, arithmetic
  and comparison primitives, `cons`/`car`/`cdr`. Environments are assoc lists
  threaded functionally; recursion is the loop form. Deep recursion is a
  measured risk: evaluator frames nest per Lisp call, so the test corpus
  keeps inputs moderate (fib 15, factorial 10, a 100-element loop unrolled in
  Lisp) and records peak depth; the wall clock and fuel knobs are the guards.
- **P3 — Lisp macros.** `defmacro`, `macroexpand`, and quasiquote/unquote at
  the *Lisp* level: macros are Lisp functions from unparsed forms to forms,
  run by `eval` before evaluation of the call — pure comptime-data-to-
  comptime-data transformation. Demonstrate `unless` and a `while` built as a
  macro over recursion. This is the section the plan exists for: the guest
  macro system is ~40 lines of comptime Yo, no host machinery.
- **P4 — Yo-bound checks.** `comptime_assert(eval(read("(fac 6)"), env) ==
  Num(720))` and friends; an unbound symbol reaches `__yo_panic` and becomes
  `compile-time panic: unbound symbol: foo` — the test asserts the *build*
  fails on a bad program via `comptime_expect_error`.
- **P5 (stretch) — compiling Lisp to Yo.** A `defn` compiles to a Yo `fn`
  source string emitted through comptime template strings (C1) and runs via
  `comptime_eval`, with `comptime_assert` checking the compiled and
  interpreted results agree. Exercises the string door and `Expr.location`
  (C3) for error attribution on generated code. Stretch because `comptime_eval`
  declares into the caller env — the derive precedent constrains what a test
  may responsibly generate; keep it to one `fn` and a `::` binding.

### 4.2 Why this is the right proof

It stresses exactly the audited weak spots — string processing (G1),
single-container data design (G2), recursion depth and fuel (G7), diagnostics
(G6) — so it doubles as the living regression test for C1/C2/C6/C7. And it is
the honest answer to "are we limiting metaprogramming?": metaprogramming's
strongest historical exhibit — Lisp — is an interpreter, and an interpreter is
a program. Yo's comptime runs programs. If a needed language feature is truly
form-shaped (new syntax, lazy control flow), the answer is a builtin desugar
by decision; if it is semantics-shaped, the answer is comptime, and §4 is that
answer demonstrated end to end.

## 5. Sequencing, sizes, seed discipline

| Item | Size | Depends on | Seed boundary |
| --- | --- | --- | --- |
| C6 `source_location` | S | — | builtin first; prelude struct after |
| C3 AST queries/constructors/`location` | M | C6 (shares `SourceLocation`) | builtin first; `Expr` method wrappers after |
| C1 comptime template strings | M | — | evaluator arm first; prelude `__s2`–`__s5` rewrite after |
| C5 big `comptime_int` | M | — | none (internal) |
| C4 promotion widening | M | — | none (internal + tests) |
| C2 `ComptimeStringMap` | M | — | builtin first; prelude type after |
| C8 `comptime_for` | S | verify-first | none (desugar + prelude sugar after) |
| C7 budget API | S | — | builtin first |
| §4 Lisp P1–P5 | M total | P5 needs C1+C3; P1–P4 run on today's engine | none (test file) |
| C9 method reflection | parked | a consumer | — |

Recommended order: **C6 → C3 → C1 → (§4 P1–P3 as the running gate) → C5 → C4
→ C2 → C8 → §4 P4–P5 → C7**. Rationale: C6/C3 are small and unblock good
diagnostics for everything after; C1 is the largest daily-value item and the
Lisp reader's prerequisite for being pleasant; the Lisp phases land early and
grow with the campaign so every item arrives with a consumer.

**VBD coupling.** None of the items changes runtime semantics, so none
conflicts with a VBD wave; the couplings are spelling (examples and the new
test file use `mut(x) ::`/`comptime(mut(x)) :=` and explicit-copy-free
comptime code) and C4's reuse of the `Comptime` auto-derivation (existing).
The campaign can start any time after the tree's spelling migration reaches
the files it touches; it does not need to wait for V5. The Lisp file and all
new prelude surface land only with post-VBD spellings.

**Verification per item** (Tier 1 norms): the comptime/collections test files
one per invocation; for value-preserving changes (C1, C5, C4) the C emit-diff
over the language corpus is empty; C5 additionally measures `check ./src`
time; every prelude/std edit re-runs `yo check ./std --std-path ./std` with
the tree binary; fmt with the tree binary; `scripts/check-issue-refs.sh`.
Docs: each landed item extends `docs/en-US/CTFE.md` + `docs/zh-CN/CTFE.md`
(and `TYPE_REFLECTION.md` for C3) in the same PR.

## 6. Prior documents

- **`plans/backlog/UNIFIED_COMPTIME_DESIGN.md` is superseded by this plan.**
  It predates self-hosting (it edits `initialization_assignment.ts` — the
  retired TypeScript compiler) and its core proposal, deleting `::` in favour
  of inferred comptime storage, is the opposite of where the language went:
  `::` stayed and decision 47 made *declared* mutability the rule
  (`mut(x) ::`, `comptime(mut(x)) :=`). Its open questions (1: keep
  `comptime_print` — yes; 2: force-runtime evaluation — no; 3: `comptime_str`
  as comptime-known `str` — the `Comptime` trait already draws this line) are
  answered by this audit. When this campaign starts, `git mv` it to
  `plans/archive/` with a supersession banner naming this doc and update
  `plans/README.md`.
- **`plans/backlog/ZIG_ADOPTION_CANDIDATES.md`**: Z3 (→ C5), Z4 (→ C6),
  Z7 (→ C8), Z8 (→ C7) and the comptime half of Z14 (→ C2) are consumed here
  with their recorded verdicts; the runtime-static-map half of Z14 stays in
  that doc.
- **`plans/backlog/MACRO_AND_ISO_REMOVAL.md`**: this plan assumes Parts A–C
  landed and adds nothing back: no quoted parameters, no unquote returns, no
  expansion registries. C2's item restriction on `derive_rule` results is
  treated as load-bearing.
- **`docs/en-US/CTFE.md`** / **`docs/zh-CN/CTFE.md`**: the user-facing
  contract this audit verified; extended per item as each lands.
