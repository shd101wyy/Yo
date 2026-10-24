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
macro machinery is deleted (the `if`/`for` spellings remain, as
builtin parse-time desugars; `for_await` was deleted on 2026-10-24 with no
desugar, its loop written out). Every Yo example below uses post-VBD spellings.
None of the additions reopen a VBD decision; §5 states the couplings
(spelling, the `Comptime` auto-derivation, which loses its only storage
exclusion when `ref` goes, and two V4 data-structure rewrites).

Anchors on develop `265faa941` (2026-10-23), after #1549. Expect drift;
each item re-runs its greps at execution time. Supersedes
`plans/archive/UNIFIED_COMPTIME_DESIGN.md` (§6 explains why it is stale).

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
| Auto-splice at the call site | Builtin desugars (`if`→`cond` since 2026-08-21; `for` in B1; `for_await` deleted 2026-10-24, B2); `derive_rule` for items; `comptime_eval` for declarations from strings |
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
mechanism, closing them is the campaign: string building has no
interpolation (§1.9 G1), the only comptime container is a cons list (G2),
AST values can be inspected but not constructed (G3), `comptime_fn` promotion
is gated on the return type and lifts only integer, float and `comptime_str`
returns (G4), and `comptime_int` is an `i64`
pattern — `u64.MAX` folds to `-1` at compile time (G5). §3 proposes the
additions that close the gaps; §4 is the proof they are enough — a Lisp with
its own macro system needs none of the deleted machinery.

Two design invariants govern everything here. The first extends the removal
decision; it is this plan's own framing, not inherited from it:

- **Exprs are data; two doors make code.** Constructing or rewriting an `Expr`
  is inert. An `Expr` becomes code through exactly `derive_rule` (items only,
  the removal plan's Part C2 restriction) and `comptime_eval` (strings). The
  removal plan names only the first door (`MACRO_AND_ISO_REMOVAL.md` §0.1:
  `derive_rule` is "the only way an `Expr` value becomes code"); counting
  `comptime_eval` as the second is this audit's addition, and §2 records the
  decision that restricts it to declarations. No addition may open a third
  door, least of all a general expression splice. The invariant holds from
  Part C (v0.2.74); until then unquote-return macros are live (§5, "The
  macro window").
- **The comptime context has no runtime storage.** Comptime values are folded
  compiler values; VBD's runtime ownership story (moves, explicit copies,
  borrow checking) does not apply inside it, and post-VBD value semantics fit
  it unchanged — a comptime aggregate was always copied structurally, which is
  what "everything is a value" says at runtime too.

## 1. What comptime is today (the audit)

Four layers — the value layer, the signature layer, the CTFE engine, and
the quote/Expr/derive layer (with its other consumers: data builtins, type
reflection, the build file) — then the gap table. Line anchors are on
`265faa941`.

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
  `where(T <: Comptime)` checks (`src/evaluator/trait_checking.yo:1503-1633`).
  `str`, `Type`, `Expr`, bool,
  every fixed-width integer, pointers to `Comptime` payloads, `Array`,
  `ComptimeList(T)`, `Option`/`Result` over comptime parts, and
  `ComptimeValue` are comptime. Reference-semantics types (`ref struct`,
  `String`, `Rc`) never are: the `is_ref` arm of the tag fast path
  (`trait_checking.yo:347-349`) and the auto-derivation's
  `!is_reference_semantics` guard (`types/utils.yo:180-183`) exclude them.
  `Dyn`, unions, `void` and the C-compat types cannot carry the `comptime`
  modifier at all (`type_prohibits_comptime_modifier`,
  `src/types/utils.yo:281-298`).
- **The `ref` flag is the only storage exclusion, and VBD deletes it.** B8
  drops `ref` from `ArrayList`/`String` (v0.2.70) and V5 Generation B from
  `Rc`/`Arc` (v0.2.74). `*T` is `Comptime` when `T` is
  (`std/prelude.yo:6987`), so after the flip `ArrayList(i32)`
  (`struct(_ptr : ?*T, _length, _capacity)`), `String`, `HashMap` and
  `Rc(i32)` would all derive `Comptime`, against §0's "no runtime storage"
  invariant. The hole is open today: `Type.impls(Box(i32), Comptime)` is
  true, because `Box` is a value newtype over a raw `*V` that owns a heap
  cell. No VBD plan or issue addresses it. This plan needs a rule — for
  example, a raw `*T` is not `Comptime`, or a type with a `Drop`/`Dispose`
  impl or an owned raw-pointer field never is, with `ComptimeList` and `Expr`
  kept as explicit impls — landed no later than B8 for `ArrayList`/`String`
  and V5 Generation B for `Rc`/`Arc` (§5; C4 depends on it).
- **The `Comptime*` operator twins**: `ComptimeAdd` … `ComptimeBitXor`,
  `ComptimeNegate`/`LogicalNot`/`BitNot`, `ComptimeEq`/`ComptimeOrd`,
  `ComptimeIndex`, the two `ComptimeRange*` traits and `ComptimeToString`
  (`std/prelude.yo:441-1066`), each a thin impl over an
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
  (`__yo_comptime_fold_range`, `std/prelude.yo:8553-8566`).
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
  body and mints a comptime clone. Tier 3 is gated on the **return type
  only** (`_to_comptime_type`, `ctfe_analysis.yo:67-81`, applied to the
  result alone by `create_comptime_function_type`, :89-120):
  `Int`/`Usize`/`Isize` and `comptime_int` map to `comptime_int`, floats and
  `comptime_float` to `comptime_float`, and `comptime_str` passes through; a
  `bool`, `str`, struct, tuple, array, enum or `Option`/`Result` return is
  unpromotable — G4. Parameters of any type that passes
  `type_prohibits_comptime_modifier` (:415-421), structs included, already
  promote.
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
`ComptimeValue` (`std/prelude.yo:7696-7711`) is the document tree: scalars plus
`List(items : ComptimeList(Self))` and `Table(keys, values)` as parallel
lists, with lookup a self-recursive linear scan (`_comptime_table_lookup`,
:7719-7732). User docs: `docs/en-US/CTFE.md`, `docs/zh-CN/CTFE.md`.

### 1.5 The AST layer (quote/Expr)

`quote(...)` returns an `Expr` (`src/evaluator/builtins/quote.yo:233-269`);
`unquote` splices a value's `Expr` in with fresh ids (:82-139) and
`unquote_splicing` a `ComptimeList(Expr)` into a call's argument list
(:152-221). `AstExpr` is `Atom(id, token) | FnCall(id, func, args, is_infix,
token)` (`src/expr.yo:399-409`) — every node carries a full token with row,
column and module path, but none of that is user-visible (part of G3). The
complete user surface is six builtins
(`src/evaluator/builtins/expr_fns.yo`): `__yo_expr_is_atom`, `is_fn_call`,
`get_callee`, `get_args`, `to_string`, `eq` — wrapped as `Expr` methods at
`std/prelude.yo:7796-7817` — plus `gensym(prefix)` minting a fresh identifier
`Expr` (`builtins/gensym.yo:30-149`) and `comptime_str.to_expr()`
(`std/prelude.yo:1396-1397`), the user door to
`__yo_comptime_string_to_expr(code)`, which parses a comptime string into an
`Expr` (`type_fns.yo:1499-1582`); `TypeFieldInfo.to_expr` and
`FieldInfo.to_expr` (:7891, :8221) only wrap a field's name in it.
(`clone_expr_fresh_ids`, `src/expr.yo:480-502`, is the compiler's
id-freshening behind `unquote`, not user surface.) **There is no
constructor**: a call's shape must come from a `quote` template — selected by
`cond`, with `unquote`/`unquote_splicing` holes, the idiom of
`DeriveContext.make_impl` (`std/prelude.yo:8516-8545`) — and an atom whose
text is computed (a field or variant name) can only come from parsing a
string (`comptime_str.to_expr()`) or `gensym`. A body of variable shape (one
`match` arm per variant) has no template either, so today's derives assemble
it as a string and parse it (`match_body.to_expr()`, `std/prelude.yo:8669`,
and its siblings at :8724 and :8785) (G3).

### 1.6 Type reflection

`TypeInfo` (30+ variants with metadata structs `TypeFieldInfo`,
`VariantInfo`, `FunctionInfo`, …; `std/prelude.yo:7881-8051`) through
`Type.get_info`/`get_struct_fields`/`get_enum_variants`, plus
`Type.eq`/`is_compatible_with`/`impls`/`contains_rc_type`/`can_form_rc_cycle`/
`to_comptime_string`, the derive workhorses `Type.join_fields`/`map_variants`
(`__yo_type_*` builtins, `src/evaluator/builtins/type_fns.yo`), and
`size_of`/`align_of`/`type_of`/`type_id`. Method reflection does not exist
(no `Type.methods`; G9). Contract: `docs/en-US/TYPE_REFLECTION.md`.

### 1.7 `derive`

Eleven self-hosted derives (`Eq`, `Clone`, `Copy`, `Hash`, `Ord`, `Default`
in the prelude, `std/prelude.yo:8581+`; `Error` in `std/error.yo`,
`ToString`/`Debug` in `std/fmt/to_string.yo`, `ToJson`/`FromJson` in
`std/encoding/json.yo`), each an ordinary comptime
function `fn(comptime(T) : Type, comptime(ctx) : DeriveContext,
comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)`,
registered for user traits by `derive_rule`
(`src/evaluator/builtins/derive_rule.yo`) with `DeriveContext.make_impl`
building the `impl(...)` by quote/unquote (:8516-8545). The returned `Expr` is
evaluated in the caller's env (`builtins/derive.yo:359-411`); C2 of the macro
removal restricts that result to items. Generic and `where`-clamped derives
work (`tests/derive.test.yo:382`). This — not the macro layer — is Yo's
metaprogramming success story, and every addition here must keep it
comfortable.

### 1.8 The build file is a comptime program

`build.yo` is evaluated in-process by the compiler's evaluator
(`src/build_runner.yo:3209-3256`); `std/build.yo` is all-comptime over 24
`__yo_build_*` builtins (`src/evaluator/builtins/build.yo:31-54`). It is the
largest existing proof that comptime Yo orchestrates real work.

### 1.9 The gaps

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | No interpolation at comptime: a template string is a runtime `String` even in a comptime position (`` s :: `n = ${n}` `` is "Expected compile-time value for \"s\""), so comptime string building is `+` chains over `__yo_comptime_string_concat` and the `__s2`–`__s5` helpers. The "FIXME: … takes super long time" over a five-piece chain is stale: that chain and a 20-piece one check in the time of an empty file (yo 0.2.68, 2026-10-23); un-commenting it is a one-line test cleanup, not part of C1 | `tests/comptime.test.yo:2856-2861`; the `__s2`–`__s5` helpers `std/prelude.yo:8567-8579` |
| G2 | `ComptimeList(T)` is the only container; no map — `ComptimeValue.Table` is parallel lists with an O(n) recursive scan; mutually recursive value shapes are inexpressible, so even a `ComptimeEntry` struct is rejected | `std/prelude.yo:7679-7732` (the doc comment says why) |
| G3 | `Expr` values can be inspected but not constructed; no atom-text/kind query, no infix flag, no token/position exposure; a computed atom (a field or variant name) and a variable-shape body can only be built by parsing a string (conditional shapes come from `cond` over `quote` templates); `__yo_expr_to_string` → `__yo_comptime_string_to_expr` round-trip is untested | §1.5 |
| G4 | `comptime_fn` promotion is gated on the return type only: `int`/`usize`/`isize` → `comptime_int`, floats → `comptime_float`, `comptime_str` passes through; a `bool`, `str`, struct, tuple, array, enum or `Option`/`Result` return is unpromotable, so "one spelling, both worlds" (CTFE.md's headline) holds only for arithmetic. Parameters of any non-runtime-only type (structs included) already promote | `src/evaluator/ctfe/ctfe_analysis.yo:67-81`, :89-120 (return only), :415-421 (parameters) |
| G5 | `comptime_int` is an `i64` pattern: `u64.MAX` folds to `-1`; unsigned division/compare above `i64.MAX` needed per-type fixes and the overflow check is on the `i64` value | `plans/backlog/ZIG_ADOPTION_CANDIDATES.md` Z3 |
| G6 | No `source_location()` — comptime diagnostics and generated code cannot cite where they came from; `comptime_assert` messages are closed strings | no such builtin (`src/expr.yo` BF_ list); Z4 |
| G7 | No explicit CTFE budget API; the knobs are env/flag only (fuel 10 000, wall clock) | §1.3; Z8 |
| G8 | No comptime iteration sugar: walking a `ComptimeList` or a type's fields inside a body hand-rolls recursion (`__yo_comptime_fold_range`) or a `while(comptime(...))` cursor. `for` over a `ComptimeList` is rejected today: E0610 (no `into_iter` on `ComptimeList`) in a runtime body, E1104 (the `for` macro's runtime `:=`) in a comptime body; B1's desugar also goes through `into_iter`, so it changes nothing here | the `for` macro's `into_iter()` call, `std/prelude.yo:10798`/`:10815`; `ComptimeList`'s only impls are `Comptime`/`Acyclic` (:7625-7626); Z7 |
| G9 | No method reflection (`Type.methods`); no consumer exists today | §1.6 |

Not gaps, recorded so they are not re-proposed: `unwrap` is not
comptime-evaluable; the comptime spelling is `comptime_unwrap` (a
`comptime(self)` method), which is outside safe mode's class-1 ban by
construction (`plans/SAFE_MODE.md` §0c); async,
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
`unquote_splicing`, `gensym`, `Expr`/`ExprList`, the `__yo_expr_*` reflection
builtins, and all of `derive` (removal plan §0.1) — plus, on the compiler
side, `clone_expr_fresh_ids`, the id-freshening behind `unquote`.
In other words, the AST *manipulation* layer was never the macro layer; only
the AST *splicing* layer was. Post-removal, an `Expr` reaches code through
`derive_rule` (items, restricted) or `comptime_eval` (strings) — the two
doors.

**`comptime_eval` is restricted to declarations (this plan's decision).** The
removal plan does not mention it. `evaluate_comptime_eval`
(`src/evaluator/builtins/type_fns.yo:1402-1496`) parses its string and
evaluates every expression in the call-site env with
`force_compile_time_bindings = false` and no shape check. It cannot act as a
statement macro today, but only by accident. Measured 2026-10-23 with a
develop-built binary: the parsed expressions never enter the AST, so codegen
never sees them. A runtime statement (`comptime_eval("println(\"x\");")`
inside `main`) is evaluated and emits nothing. A runtime binding
(`comptime_eval("y := i32(5);")`, then `println(&y)`) passes the evaluator
and fails the C compile on an undeclared `__yo_v_y`. A function declaration
carries over and is callable. (One whose body carries an overflow trap fails
the C compile: the trap's site string embeds the `auto-generated://`
pseudo-path, generated source and newlines included, unescaped in a C string
literal. Not yet filed.) The rule, mirroring C2's item restriction on derive
results: `comptime_eval` accepts declarations (`::` bindings, function and
type definitions, `impl`s) and rejects anything else with a diagnostic, which
turns the two silent miscompiles into errors. With C3's constructors and
`Expr.to_string` feeding it, that restriction is what keeps it from becoming
an unrestricted statement-level path. `MACRO_AND_ISO_REMOVAL.md` §0.1
cross-references this decision.

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

### C1 — Comptime template strings (M)

**Close G1.** In a comptime context — a `-> comptime(...)` body, a comptime
binding's initializer, a `comptime(...)` argument — a template string
`` `text ${expr}` `` evaluates to a `comptime_str` with its interpolations
folded, instead of building a runtime `String`. Interpolands are
comptime-known values rendered through `ComptimeToString`
(`comptime_int`/`float`/`bool` and the fixed-width integers have the trait
today, and `comptime_str` is its own rendering; anything else must spell
`.to_comptime_string()` explicitly, matching runtime `ToString` discipline).
Interpolating an unknown value is the existing "runtime argument to
compile-time parameter" error. At runtime, template strings are unchanged.

Gate: a test in `tests/comptime.test.yo` interpolating each
`ComptimeToString` type into a comptime binding and checking the result with
`comptime_assert`, plus the unknown-value error; and the prelude's
`__s2`–`__s5` helpers (`std/prelude.yo:8567-8579`) rewritten to interpolation
once the seed carries the feature (their callers are the derive rules).
Concatenation cost is not part of C1: the `tests/comptime.test.yo:2856` FIXME
is stale (§1.9 G1), and un-commenting its five-piece assert is a test cleanup
that can land any time.

No new syntax — it makes an existing literal do the comptime thing in the
comptime place. The alternative (a `format` builtin) is rejected: two
spellings for one operation.

### C2 — A comptime map (M)

**Close G2.** A `ComptimeDict(V)` comptime-only type: parallel
`ComptimeList(comptime_str)`/`ComptimeList(V)` fields (the shape
`ComptimeValue.Table` already legitimizes) with construction from a comptime
list of pairs, and lookup through one builtin,
`__yo_comptime_dict_get(dict, key) -> Option(V)`, executed in compiler
code — a linear scan below a cutover size, binary search over a sorted copy
above it (the cutover is a named constant fixed in the PR that adds the
sorted path). Written-in-Yo lookup (`_comptime_table_lookup`
style) is rejected as the interface: every element fetch is an AST walk.
Gate: a test in `tests/comptime.test.yo` building a dict from a pair list and
asserting hit and miss lookups with `comptime_assert`, on both sides of the
cutover if the sorted path is kept.

General `ComptimeMap(K, V)` (any comptime `K` with `ComptimeEq`) is a
follow-on, not the first cut — strings are every real key today (symbol
tables, embed-file indexes, generated-code registries). This is not Z14:
Z14's `ComptimeStringMap(V)` (Zig's `StaticStringMap`, a comptime-built
table that lowers to runtime data) is one item whose consumers are runtime
code — the lexer's keyword dispatch and `src/cli_lang.yo`. It stays open in
`ZIG_ADOPTION_CANDIDATES.md` under its own name, and this type is named apart
so the two never collide. Recursion-depth note: a dict built by fold over a
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
  constructing module. A computed atom and a variable-shape body (one arm
  per variant) no longer round-trip through strings.
  `make_infix(op, lhs, rhs)` is sugar over `make_call` if the fmt
  round-trip needs it — decide at implementation.
- Provenance: `Expr.location(e) -> Option(SourceLocation)` exposing the head
  token's file, line and column through C6's `SourceLocation` (Z4's shape;
  `function` names the function enclosing the node's site, empty at module
  scope).

The two-door invariant is unchanged and testable: nothing here evaluates an
`Expr`; a property test pins
`string_to_expr(expr.to_string(e)) == e` (modulo ids) for the round trip, and
derive rules migrate to constructors opportunistically (the string-building
arm of `__derive_default`'s index trick, `std/prelude.yo:9099-9133`, is the
first beneficiary — it exists because `to_comptime_string` of an instantiated
generic renders placeholders; constructors sidestep rendering entirely).

### C4 — Widen CTFE promotion to every comptime signature (M)

**Close G4.** `_to_comptime_type` (`src/evaluator/ctfe/ctfe_analysis.yo:67-81`),
applied by `create_comptime_function_type` (:89-120) to the return type
alone, today maps `Int`/`Usize`/`Isize` → `comptime_int` and floats →
`comptime_float` and passes `comptime_str` through, nothing else. Parameters
are not gated by it: any parameter type that passes
`type_prohibits_comptime_modifier` already promotes, structs included
(`comptime_fn` over `fn(p : Point) -> i32` checks clean today). Extend the
return mapping to: `bool` (it is already a comptime
value type), `str` → `comptime_str`, and every type the existing `Comptime`
auto-derivation already blesses — comptime value structs, tuples, fixed
arrays, enums, `Option`/`Result` of promotable parts — reusing §1.1's field
rules so there is exactly one definition of "comptime-shaped". Then
`comptime_fn(f)` works for `fn(a : Point, b : Point) -> bool`, which fails
today only because of its `bool` return, and CTFE.md's "one spelling,
both worlds" claim becomes true for more than arithmetic. The capability
analysis itself (trial-evaluate, mint a clone) is unchanged; only the
return gate widens. **Depends on §1.1's storage exclusion:** once `ref` is
gone, reusing the derivation without it would promote functions returning
`ArrayList(i32)` or `String` (the trial evaluation still refuses a real
allocation, but the marker and §0's invariant would be wrong).

### C5 — Arbitrary-precision `comptime_int` (M, correctness)

**Close G5.** Adopt Z3 (its verdict: a soundness fix). Representation is
internal to the compiler (an arbitrary-precision integer in the compiler's own
runtime — `std` has no big-integer support today, so an internal one; not
new surface). Rules: comptime arithmetic is exact and cannot
overflow; narrowing to a fixed width keeps today's range errors (now checking
the true value); the `u64`-above-`i64.MAX` special cases
(`tests/comptime.test.yo:3408-3504`) keep passing because unsigned semantics
are now derived from the value, not patched per type. The PR records
`check ./src` CTFE time before and after (Z3's own instruction; a
measurement, not a pass threshold).

### C6 — `source_location()` and `SourceLocation` (S)

**Close G6.** Adopt Z4 with its recorded shape: a builtin
`source_location() -> SourceLocation`, folded where it is written. C6 owns
the prelude type and defines it in the same PR as the builtin (a plain struct
needs no newer seed):
`SourceLocation :: struct(file : str, line : u32, column : u32, function : str)`,
`Copy` and `Comptime`, usable at comptime and at runtime alike. A defaulted
parameter `loc : SourceLocation = source_location()` gives an assert or log
helper its caller's site (Z4's use). Consumers: `std/assert`, `std/log` and
`std/testing`; Z11's `--allocator debug` leak table, which takes its
allocation sites from it (`ZIG_STYLE_ALLOCATORS.md` A2) — Z11 is decision
48's W6 precondition 2, scheduled for v0.2.70, so C6 is wanted by v0.2.70 if
that site column is to ship with it; `comptime_assert` messages;
generated-code diagnostics; and the Lisp interpreter's error attribution
(§4). Gate: a test in `tests/comptime.test.yo` asserting `file`, `line` and
`column` at a known site, plus one `comptime_assert` message that uses it.
Small, no dependencies, land first.

### C7 — CTFE budget API (S, low priority)

**Close G7.** Adopt Z8: a default per-eval branch quota with
`comptime_budget(n)` for the sites that legitimately need more (a table
generator, the Lisp interpreter's evaluator). We already have fuel and a wall
clock; this makes the limit nameable at the site that raises it instead of an
env var. Not blocking anything; land with whichever C item first trips the
fuel cap in a test.

### C8 — `comptime_for` (S)

**Close G8.** Z7's verify-first is answered (§1.9 G8): `for` over a
`ComptimeList` is rejected today in both body kinds, and B1's desugar goes
through `into_iter` too. So add `comptime_for(xs, x => body)` outright —
unrolled iteration over a `ComptimeList` (and, as sugar over `TypeInfo`, a
type's fields) — as an **evaluator builtin form**. It cannot be a parse-time
desugar (a parse-time rewrite runs before a list's length or a type's fields
are known, so it cannot unroll), nor Z7's prelude macro (the macro removal
rules that out). The evaluator evaluates `xs` under CTFE, then evaluates the
body once per element with `x` bound, the way `while(comptime(...))` unrolls
today; in a runtime body it emits one body instance per element. It is a
closed builtin form, not a new user splice door. Size cap: unrolling mints a
body per element, and a wide list times a fat body explodes the AST, so the
evaluator counts unrolled elements against a named default (the loop fuel's
10 000, sharing its override) and fails past it with a new E-code that names
the site. Gate: tests in `tests/comptime.test.yo` walking a `ComptimeList`
and a struct's fields in a comptime body and in a runtime body, plus one that
hits the cap and checks the E-code.

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
  storage; `ComptimeDict` (C2) is the comptime shape.
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

Data (all comptime; self-recursion goes through `ComptimeList(Self)`, which
is expressible — mutual recursion between two distinct types is not, the
`ComptimeValue` precedent — so `Lisp` is the only type, and environments
and closures are `Lisp` data: tagged lists, not structs):

```yo ignore
// A Lisp value. The whole language is one recursive type. Lists are flat
// (items indexed and sliced — car is index 0, cdr the 1.. range), a pair is
// a 2-element list, and environments and closures are tagged lists rather
// than structs:
//   env     ::= a list of (name value) 2-element lists
//   closure ::= (closure (params...) body env)
// A LispClosure struct would need a Closure variant in Lisp, which is the
// mutually recursive value shape G2 records as inexpressible — so closures
// and environments are lists, not structs.
Lisp :: enum(
  Num(v : comptime_int),
  Str(v : comptime_str),
  Sym(v : comptime_str),
  Nil,
  List(items : ComptimeList(Self))
);
```

Every interpreter function takes comptime parameters and returns a comptime
value. A runtime signature such as `(fn(e : Lisp) -> Lisp)` does not reach
CTFE: only a `-> comptime(T)` return routes a call there (§1.2), and tier-3
promotion cannot lift an enum return (G4). Measured 2026-10-23 with yo
0.2.68 on the enum above: `r :: bump(Lisp.Num(6))` over that signature is
"Expected compile-time value for \"r\"", while
`(fn(comptime(e) : Lisp) -> comptime(Lisp))` checks clean. `Lisp` has no
`==` — it is a plain enum, and `derive(Lisp, Eq(Lisp))` on this recursive
comptime enum fails today with E0601 (the generated match body is typed
unit; it would need its own issue) — so the checks assert through `match`
or a hand-written comptime `lisp_eq`, and variants are written qualified
(`Lisp.Num(720)`).

Phases, each landing green before the next with its own `comptime_assert`
checks:

- **P1 — the reader.**
  `read :: (fn(comptime(src) : comptime_str) -> comptime(Lisp))`: a
  `while(comptime(...))` tokenizer over byte slices (`.len()`, `.slice()`,
  comparisons — all existing comptime string ops), then recursive descent to
  S-expressions. It is the string-heavy stage, the first consumer of comptime
  string building (G1). Checks: `read` produces the expected `Lisp` for known
  forms (atoms, strings, nested lists).
- **P2 — the evaluator.**
  `eval :: (fn(comptime(e) : Lisp, comptime(env) : Lisp) -> comptime(Lisp))`,
  matching on the head symbol: `quote`, `if`, `lambda` (a closure is the
  tagged list above — no host fn values involved), `let`, arithmetic
  and comparison primitives, `cons`/`car`/`cdr`. Environments are assoc lists
  threaded functionally — the pre-C2 shape; once C2 lands, the same test
  re-points symbol lookup at `ComptimeDict` and keeps the assoc path
  covered beside it. Recursion is the loop form. Deep recursion is a
  measured risk: evaluator frames nest per Lisp call, so the test corpus
  keeps inputs moderate (fib 15, factorial 10, a 100-element loop unrolled in
  Lisp) and records peak depth; the wall clock and fuel knobs are the guards.
  Checks: arithmetic, `let`, `lambda` and recursion results, for example
  `comptime_assert(match(eval(read("(fac 6)"), env), .Num(n) => (n == 720), _ => false))`.
- **P3 — Lisp macros.** `defmacro`, `macroexpand`, and quasiquote/unquote at
  the *Lisp* level: macros are Lisp functions from unparsed forms to forms,
  run by `eval` before evaluation of the call — pure comptime-data-to-
  comptime-data transformation. Demonstrate `unless` and a `while` built as a
  macro over recursion. This is the section the plan exists for: the guest
  macro system is a few dozen lines of comptime Yo (an estimate, not a
  measurement), no host machinery. Checks: the `unless` and `while` results,
  and `macroexpand` of each against its expected form.
- **P4 — the build-failure check.** An unbound symbol reaches `__yo_panic`
  and becomes `compile-time panic: unbound symbol: foo` — the test asserts
  the *build* fails on a bad program via `comptime_expect_error`.
- **P5 (stretch) — compiling Lisp to Yo.** A `defn` compiles to a Yo `fn`
  source string emitted through comptime template strings (C1) and runs via
  `comptime_eval`, with `comptime_assert` checking the compiled and
  interpreted results agree. If the compiled `fn` is also called at runtime,
  it needs the overflow-trap site-string bug of §2 fixed first (compiled
  arithmetic carries traps). Exercises the string
  door and `Expr.location`
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
| C6 `source_location` + `SourceLocation` | S | — | builtin and prelude struct together (a plain struct needs no newer seed) |
| C3 AST queries/constructors/`location` | M | C6 (uses its `SourceLocation`) | builtin first; `Expr` method wrappers after |
| C1 comptime template strings | M | — | evaluator arm first; prelude `__s2`–`__s5` rewrite after |
| C5 big `comptime_int` | M | — | none (internal) |
| §1.1 `Comptime` storage exclusion | S–M | — | none (internal); by B8 (v0.2.70) for `ArrayList`/`String`, by V5 Gen B (v0.2.74) for `Rc`/`Arc` |
| C4 promotion widening | M | §1.1 storage exclusion | none (internal + tests) |
| C2 `ComptimeDict` | M | — | builtin first; prelude type after |
| C8 `comptime_for` | S | — | builtin first; prelude/field sugar after |
| C7 budget API | S | — | builtin first |
| `comptime_eval` declaration restriction (§2) | S | — | none (evaluator diagnostic) |
| §4 Lisp P1–P5 | M total | P5 needs C1+C3; P1–P4 run on today's engine with comptime signatures (§4.1) | none (test file) |
| C9 method reflection | parked | a consumer | — |

Recommended order: **C6 → C3 → C1 → (§4 P1–P3, each with its checks, as the
running gate) → C5 → §1.1 storage exclusion → C4 → C2 → C8 → §4 P4–P5 →
C7**, with the `comptime_eval` restriction any time. Rationale: C6/C3 are
small and unblock good diagnostics for everything after; C1 is the largest
daily-value item and the Lisp reader's prerequisite for being pleasant; the
Lisp phases land early and grow with the campaign so every item arrives with
a consumer. The storage exclusion has its own deadline (B8) whatever the
campaign's pace.

**The macro window.** Part A landed (v0.2.68, #1530); B1/B2 come at v0.2.73
and Part C at v0.2.74. Until Part C, unquote-return macros and the
unrestricted `derive_rule` splice are live, so §0's two-door invariant
becomes true only at v0.2.74. Items that add only inert data (C1, C2, C5,
C6) may land any time. C3's constructors may land early too: they add no
splice power while macros are live, because a macro already splices any
`Expr` it returns. The `comptime_eval` restriction need not wait for Part C.

**VBD coupling.** None of the items changes runtime semantics, but three
touch what VBD reshapes. (1) The `Comptime` derivation loses its only storage
exclusion when `ref` goes (§1.1): the exclusion lands by B8 (v0.2.70) for
`ArrayList`/`String` and by V5 Generation B (v0.2.74) for `Rc`/`Arc`, and C4
depends on it. (2) C3 mints `AstExpr` nodes, which V4 converts to `Rc(Self)`
children at v0.2.72. (3) C5 changes `comptime_int`'s representation inside
`EvalValue`, which V4 reshapes at v0.2.73. C3 and C5 land clearly before or
after their V4 PR, never inside its review window. The remaining coupling is
spelling (examples and the new
test file use `mut(x) ::`/`comptime(mut(x)) :=` and explicit-copy-free
comptime code).
The campaign can start any time after the tree's spelling migration reaches
the files it touches; it does not need to wait for V5. The Lisp file and all
new prelude surface land only with post-VBD spellings.

**Verification per item** (Tier 1 norms): `tests/comptime.test.yo`,
`tests/derive.test.yo` and, for C3, `tests/internal/ast_reflection.test.yo`,
one per invocation; for value-preserving changes (C1, C4) the C emit-diff over
the language corpus is empty — C5 is deliberately not in that list: it changes
the folded value of `u64`/`usize` arithmetic above `i64.MAX`, so its emit-diff
may move only inside the `tests/comptime.test.yo:3408-3504` fixtures, and its
PR records `check ./src` time before and after; every prelude/std edit re-runs
`yo check ./std --std-path ./std` with the tree binary; fmt with the tree
binary; `scripts/check-issue-refs.sh`.
Docs: each landed item extends `docs/en-US/CTFE.md` + `docs/zh-CN/CTFE.md`
(and `TYPE_REFLECTION.md` for C3) in the same PR.

## 6. Prior documents

- **`plans/archive/UNIFIED_COMPTIME_DESIGN.md` is superseded by this plan**
  and was archived, with a supersession banner, in this plan's PR.
  It predates self-hosting (it edits `initialization_assignment.ts` — the
  retired TypeScript compiler) and its core proposal, deleting `::` in favour
  of inferred comptime storage, is the opposite of where the language went:
  `::` stayed and decision 47 made *declared* mutability the rule
  (`mut(x) ::`, `comptime(mut(x)) :=`). Its open questions (1: keep
  `comptime_print` — yes; 2: force-runtime evaluation — no; 3: `comptime_str`
  as comptime-known `str` — the `Comptime` trait already draws this line) are
  answered by this audit.
- **`plans/backlog/ZIG_ADOPTION_CANDIDATES.md`**: four items are consumed
  here, three of them with departures from their recorded verdicts. Z3 (→ C5)
  as recorded. Z4 (→ C6) keeps its runtime-usable shape; C6 adds Z11's leak
  table and the comptime consumers. Z7 (→ C8): its verdict was a prelude
  macro, which the macro removal rules out, so `comptime_for` is an evaluator
  builtin form, and its verify-first is answered (§1.9 G8). Z8 (→ C7): its
  "no budget/quota/fuel" premise is stale; §1.3 records the fuel cap and the
  wall clock. Z14 is not consumed: its `ComptimeStringMap(V)` has runtime
  consumers and stays open there, and C2's comptime-only `ComptimeDict` is
  named apart. Each consumed Z item carries a pointer to its C item.
- **`plans/backlog/MACRO_AND_ISO_REMOVAL.md`**: Part A landed (v0.2.68,
  #1530), B1/B2 come at v0.2.73 and Part C at v0.2.74 (§5, "The macro
  window"). This plan adds nothing back: no quoted parameters, no unquote
  returns, no expansion registries. Part C2's item restriction on
  `derive_rule` results is treated as load-bearing, and §2's `comptime_eval`
  restriction is this plan's matching rule for the second door; §0.1 of that
  plan cross-references it.
- **`docs/en-US/CTFE.md`** / **`docs/zh-CN/CTFE.md`**: the user-facing
  contract this audit verified; extended per item as each lands.
