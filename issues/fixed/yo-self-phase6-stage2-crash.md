# Phase 6 (self-host fixpoint): stage-2 self-compile crashes on the full self-source

## Status

**✅ FIXED (2026-06-20): enum `!=` (derived-Eq) — parser 13 → 9.** `a != b` on a
derived-Eq enum produced `unit` (soft-fallback): `derive(Eq)` generated only `==`,
and the `!=` method is the Eq trait's `?=` default (`not(Self.(==)(lhs, rhs))`),
which was never registered/dispatched on the receiver. Two layers were explored:

1. **Dispatch (solved, then superseded):** an impl-registration default-fill that
   registers + MONOMORPHIZES the trait's unprovided `?=` defaults for the receiver
   (via a `create_specialized_function_inline` slot, ctx.self_type = receiver).
   This made `!=` DISPATCH (parser 13→9/10, corpus 77/77) — BUT the monomorphized
   default BODY "Failed to transpile": `create_specialized`'s body re-eval does NOT
   codegen-record the default body's operator call, whether written `Self.(==)
(lhs, rhs)` OR the equivalent `not(lhs == rhs)` (a standalone `not(a == b)`
   codegens fine; only the create_specialized-monomorphized body fails). This is a
   deeper `create_specialized` limitation (trait-`?=`-default bodies) — REVERTED.

2. **derive generates `!=` (SHIPPED):** `__derive_eq` (std/prelude.yo) now emits
   `(!=) : ((lhs, rhs) -> not(lhs == rhs))` alongside `==` for the struct, enum,
   and empty-enum branches. The `!=` is then a PROVIDED method, evaluated/codegen'd
   exactly like `==` (no create_specialized). Shared std → both compilers stay
   consistent. Validated: enum-`!=` repro runs identically on TS and yo-self;
   `tests/codegen-bootstrap/enum_ne_dispatch.yo` (new fixture, exercises `!=` in
   `&&` + `cond` guards) passes DIFF 0; corpus 78/78; TS `check ./std` 152/152;
   parser 13 → 9.

REMAINING (related, NOT yet fixed — 3rd revert): HAND-WRITTEN `Eq` impls that
provide only `==` and rely on the `!=` default (`impl(String, Eq(str))` etc.) still
fail in yo-self (`s != "->"` C-compile-fails while TS prints `Y`). The general fix
(impl-registration default-fill: register + monomorphize the unprovided default
via `create_specialized_function_inline`) was attempted with the layer findings:

- The default body's "Failed to transpile" ROOT = `create_specialized` assumes
  params are PRE-BOUND by `try_to_call` (its rebind loop only handles closure /
  folded-const params); a direct caller leaves `lhs`/`rhs` unbound → body can't
  resolve. Binding unbound params (npv==0) inside create_specialized DOES make
  the `!=` body codegen — BUT it also fires on io_async closure-param
  specialization and REGRESSED the corpus (SELF-FAIL io_async_capture). The
  npv==0 guard is NOT actually direct-call-only.
- Even with params bound, String `!=` then hits a struct-id MISMATCH in the
  monomorphized body (`_bytes` `Option` id 3990 vs canonical 3841) — the
  create_specialized re-eval mints a different `Option` struct id.
  So the general path needs a DIRECT-CALL-ONLY param bind (not the shared
  create_specialized rebind loop) AND struct-id stability across monomorphized
  default bodies. The band-aid (explicit `(!=)` per impl) also regressed the TS std
  (152→104: heterogeneous `Eq(str)` `self == other` mis-resolves the `==` overload).
  The SHIPPED fix is `derive(Eq)` generating `!=` (covers derived enums); hand-written
  Eq defaults + other trait `?=` defaults (Ord, Error.source) remain a parity gap.

**✅ PROGRESS (2026-06-20): operator OVERLOAD selection — String `==` str fixed
(parser 14 → 13).** `v == "->"` (String == str literal) failed with "Cannot unify
String and str": `String` implements both `Eq(String)` (rhs: String) and
`Eq(str)` (rhs: str), but yo-self's infix dispatch always took `op_methods[0]`
and tried to unify the `str` arg against the `String` parameter. FIX
(function.yo infix path): when a receiver has >1 overload of the operator,
evaluate the 2nd operand (under a capture-free swallow — `_try_eval_operand_type`
— so a `.Variant`-shorthand operand that needs an expected type falls back
instead of aborting) and pick the overload whose 2nd parameter (`rhs`) type
accepts that operand's type (`are_types_compatible`). Single-overload operators
keep index 0 (no change). Mirrors TS trying each overload (function.ts:867+).
Validated: corpus 77/77 (DIFF 0), parser 14 → 13. Fixing `v == "->"` surfaced the
NEXT layer at expr.yo:673 — `match(inner_func_box.*, .Atom(...) => …)` throws
"Enum variant Atom not found in <enum:...\_self_shell>": matching a `.Variant`
shorthand against a self-referential enum (`AstExpr`) while it is still a
FORWARD-SHELL. That (shorthand-match-on-self-shell) is the next parser bug.

REMAINING parser waves (13): 7× frame-level (std/string begin-block arms,
benign), 2× `array_list(...)` (macro, MACRO_DISPATCH-gated), 1× panic-msg, 1×
enum `!=` (the Eq `?=` default `!=` is NOT registered/dispatched on the receiver
→ soft-fallback `unit`; only surfaces under strict bool checks — `&&`/`||`,
`if`/`while`; needs trait-`?=`-default filling at impl registration), 1×
`.Atom`-on-self-shell (above).

**MEMORY REDUCTION ATTEMPTED (2026-06-20) — clones are LOAD-BEARING, needs a
structural redesign.** Re-profiled (peak physical footprint **36.9 GB** at a 2 GB
stack). Findings: `create_specialized_function_inline` already checks its cache
BEFORE cloning the body (cache hits don't re-clone — clone churn is inherent to
monomorphization, one body-clone per DISTINCT specialization); `ArrayList.clone`
already pre-sizes via `with_capacity` (no growth reallocs). Two clone-elimination
ideas were rejected: (1) MEMOIZE `TypeValue.clone` (return a shared clone for a
given id) — UNSAFE because `TypeValue`'s `ArrayList` fields are reference-semantics
objects, so a shared clone's fields alias and a later in-place `push`/`set`
corrupts every holder; (2) short-circuit `substitute` to return `ty` unchanged on
an EMPTY substitution — REGRESSED the corpus (SELF-FAIL 1): a caller relies on
`substitute` yielding a DISTINCT fresh copy (identity), so the deep reconstruction
is load-bearing, not redundant. CONCLUSION: the per-clone churn is intrinsic to
yo-self's value-typed `TypeValue`/`EvalValue`/`AstExpr` representation (the TS
compiler avoids it via reference-typed type objects shared by identity). A safe
reduction requires a structural redesign — make the large type/value enums
shared-immutable (Rc/interned) so clone is a refcount bump, with an
immutability/COW guarantee for their `ArrayList` fields — a large, regression-prone
refactor. On THIS 16 GB machine the unified fixpoint is memory-bound; a 32 GB+
machine fits the 9–37 GB footprint. The per-module path stays memory-feasible.

**MEMORY PROFILE (2026-06-20): unified `main.yo` compile is clone-dominated.**
With a 2 GB stack (not 8 GB — the 8 GB reservation starved the heap on this 16 GB
machine, causing the rc=137), `main.yo --release` compile runs ~126 s, peaks at
**9.2 GB RSS** with an **89.5 GB cumulative allocation footprint**, then is
memory-killed under pressure. `sample` shows the hot leaves are overwhelmingly
CLONE: `id_635 clone` (ArrayList(TypeValue).clone, 4408) + `id_73 clone` (3713)
dominate `_find_bucket` (2790), `evaluate_expression` (2643),
`evaluate_function_call` (2236), `expr_info_table_set` (2000). So the unified
fixpoint is now MEMORY-bound (pervasive deep-cloning of value-typed `TypeValue`s —
an architectural cost the TS compiler avoids via reference-typed type objects),
NOT recursion- or transpile-error-bound. Fitting 16 GB needs a major clone-
reduction effort (share/intern types, or audit out redundant `.clone()` sites) or
a bigger machine. The PER-MODULE path stays memory-feasible and is the route for
fixing the (orthogonal) per-module transpile errors. Next per-module: the
`(a == b) && (c == d)` comparison cluster (String==str overload + enum `!=`
producing a non-bool operand).

**✅ PROGRESS (2026-06-20): unified `main.yo` self-compile rc=138 → rc=137 —
infinite Clone recursion FIXED; OOM is the remaining blocker.** An `lldb`
backtrace (small `YO_MAIN_STACK_MB=512` to crash fast) pinned the rc=138 crash to
`clone_specialized_T_TypeValue` recursing forever on a cyclic `TypeValue`. The
manual cycle-aware Clone (definitions.yo) guarded EnumT/Struct by id, but the
`TraitT` and `DynT` arms cloned children unconditionally — so the self-referential
std `Error` trait (`source : fn(self) -> Option(Dyn(Error))`) looped
`TraitT(Error) → tft → Option(Dyn(Error)) → DynT.required_trait_types →
TraitT(Error) → …`. FIX: added a `tid`-based cycle guard to the `TraitT` arm
(mirrors EnumT/Struct — when the trait id is on the clone path, share `tft`
instead of deep-cloning). Validated: corpus 77/77 (DIFF 0), parser.yo still 14
(no regression). The unified `main.yo --release` compile now runs much further
and is **OOM-killed (rc=137 = SIGKILL)** instead of recursing — the documented
"memory-heavy unified load". The recursion blocker is closed; reducing the
compile's peak memory (excessive large-cyclic-TypeValue clones) is the next
fixpoint blocker. The PER-MODULE path stays memory-feasible and is unaffected.

**✅ PROGRESS (2026-06-20): parser.yo 34 → 14 transpile errors — `box(.Variant)`
early-forall-synth fixed.** The biggest parser wave (8× "Failed to evaluate
argument expression") was `box(.Atom(...))` / nested `.FnCall(...)` constructions:
a `.Variant`-shorthand argument INSIDE `box(...)` failed with "Failed to infer
enum variant type" because `box`'s `forall V` was not bound to the concrete enum
before the argument was evaluated. ROOT: yo-self's FuncVal-arm call path
(`function.yo`, `.FuncVal(...)` arm) sets each argument's expected type from the
DECLARED parameter type; for `box`'s `value : V` that is an unresolved `forall`
SomeT, which it SKIPS (`is_some_type(apt) => None`), leaving `.Atom` with no
expected enum type. TS does **early synthesis** (`helper.ts:1283-1310`): bind the
foralls from the expected RETURN type (`Box(Tree)` → `V = Tree`) BEFORE evaluating
args, then pass the concrete param type. FIX: `resolve_param_types_from_expected`
(helper.yo) builds a placeholder synth env, synthesizes the foralls from the
expected return type, re-evaluates the declared param types to concretes, and
returns them via an `out` param (the swallow handler is capture-free `->`, so it
unwinds `()` — results ride out via `out`, like `_trial_eval_fn_body`). The
FuncVal arm calls it once (when there's an expected type, forall params, and no
explicit `forall(...)`), then uses the resolved param types as each arg's expected
type. Validated: box repro fixed, corpus 77/77 (DIFF 0), parser 34→14.

REMAINING parser waves (14): 7× "Frame level is different" (6 in std/string
begin-block cond/match arms + 1 parser.yo:488 — swallowed, do NOT block
std/string codegen which compiles clean for token/lexer); 2× `array_list(...)`
("Failed to evaluate argument expression") — `array_list` is a MACRO
(`unquote(Expr)` return), blocked on MACRO*DISPATCH (gated off, heap-corruption);
2× "Cannot unify String and str" (`v == "->"` — heterogeneous-Eq overload
resolution picks `impl(String, Eq(String))` and fails to unify the `str` arg
instead of `impl(String, Eq(str))`); 2× "Expected bool type for and/or" (downstream
of the String/str `==`); 1× "panic message must be comptime_str or str". NEXT:
the String/str Eq overload (tractable dispatch fix — `get_receiver_methods_by_name*
from_env`returns both overloads and`function.yo`takes`[0]` instead of matching
the arg type).

**✅ MILESTONE (2026-06-20): token.yo AND lexer.yo BOTH FULLY SELF-COMPILE** to
valid C (zero transpile errors + clang -c rc=0). The self-referential Dyn(Error)
chain is fully resolved (commits a822b16dd…3e6463f6b; see the memory note
`yo-self-phase6-stage2-crash-root` for the full chain). Corpus 77/77.

**NEXT module — parser.yo:** emits C but with 36 transpile errors. ROOT: malformed
METHOD SIGNATURES — e.g. `Parser.get_program` (`fn(self, exn) -> ArrayList(AstExpr)`)
is emitted as `void fn_..._get_program(void)` (no params, void return), so its body
(referencing self/exn) all "Failed to transpile". A few such malformed-signature
methods account for all 36 errors. This is a FUNCTION-GENERATION gap. ROOT refined: `generate_function`
(functions/generation.yo:135) reads `get_func_type(func_id)`; `get_func_type`
returns `t_unit()` for an UNREGISTERED func_id (function_value.yo:160), and
`generate_function_prototype(t_unit, …)` yields `void fn(void)`. So
`get_program`'s func type was never registered under the func_id codegen
collected. token.yo + lexer.yo (which have impl methods) self-compile fine, so
general impl-method func-type registration WORKS — `get_program` is special: it
sits in a FORWARD-REFERENCE/recursion cycle (parser.yo:474 comment:
"avoids forward reference: parse_template_string → get_program cycle"; it also
self-recurses via `Parser.new(...).get_program(...)`). The likely cause: the
forward-SHELL FuncVal created for the mutual-recursion ref (impl.yo
`_try_create_forward_shell`/`register_type_trait_method` shell path) is what
collection picks up, and its func_id has no `register_func_type` entry → t_unit →
void(void). NEXT: ensure the forward-shell (or the collected method FuncVal for a
recursive impl method) has its func TYPE registered under the SAME func_id codegen
uses — verify the shell's id == the finalized method's id, and that
register_func_type runs for it. Distinct from the Dyn(Error) chain; the next
per-module step.

**PARTIAL FIX (commit 1d28fbfee) + DEEPER GAP (2026-06-20):**
`_try_create_forward_shell` now calls `register_func_type(shell_fid, fn_ty)` — so
the recursive-method SIGNATURE is now correct (`get_program` → `ArrayList* fn(Parser*
self, Exception exn)`, no longer `void fn(void)`). Corpus 77/77, lexer still clean.
BUT parser.yo still has 36 transpile errors: the shell carries the UNEVALUATED body
(no ExprInfo), and the main pass updates the registry ENTRY's value to the real
method (impl.yo:2073) — but the real method has its OWN func_id, while the
forward-ref CALL SITES captured the SHELL's func_id (the real didn't exist yet).
yo-self FuncVals are immutable VALUES (unlike TS's mutated-in-place shell object),
so call sites still resolve to the shell id → codegen emits the shell's unevaluated
body ("Failed to transpile"). TRIED: making the real method ADOPT the shell's
func_id on update (so call sites hit the real body) — REGRESSED the corpus
(SELF-FAIL 1), reverted. So the reconciliation needs a non-id-swap approach: e.g.
register the real method's body+type under the shell func_id in the function
registry codegen reads (without changing the FuncVal identity others hold), or make
the shell carry/lazily-resolve the evaluated body. Note parser.yo is a HEAVIER
module — beyond get_program the 36 errors span other recursive/forward-ref methods;
expect a broader wave than lexer.yo had.

**WHY the func_id-adoption regressed (root, for the next attempt):** there are TWO
func_ids for a forward-shelled method. FORWARD-ref call sites (incl. the method's
own self-recursion, evaluated while the entry still held the shell) capture the
SHELL id; NON-forward call sites (e.g. parser.yo:1444's top-level
`p.get_program(exn)`, evaluated AFTER the main pass updated the entry to the real
method) resolve to the REAL id. Making the real method adopt the shell id fixed the
forward sites but BROKE the non-forward ones (→ corpus SELF-FAIL). So NEITHER single
id works for both. TS has one identity (mutated-in-place shell). The yo-self fix
must make BOTH ids emit the real body: maintain a `shell_fid → real FuncVal` map
(recorded at the impl.yo:2073 shell-update), and in codegen function-collection,
when a func is collected/generated under a shell_fid, substitute the real method's
FuncVal (so the shell_fid's c_name emits the real evaluated body). Validate corpus
77/77 + lexer + parser after.

**IMPLEMENTATION CONSTRAINT (tried 2026-06-20, reverted): EvalValue MOVE-semantics
block storing the real FuncVal in two places.** EvalValue has no `.clone()`
(method) and `clone_value(v, …)` returns a FuncVal as-is BUT takes `v` BY VALUE
(consumes it) — so you can't keep `method_val` for both the registry entry
(`ex_entry.value`) AND a `shell→real FuncVal` redirect map. So the redirect must
NOT duplicate the FuncVal. VIABLE PATH: store the redirect as `shell_fid →
real_func_id` (String→String, no FuncVal). Then in codegen, generate the SHELL
function as a THUNK that forwards to the real method: emit
`<ret> <shell_cname>(<params>) { return <real_cname>(<params>); }` (params/return
from get_func_type(shell_fid) — already registered via 1d28fbfee; real_cname =
sanitize(real_func_id)). The thunk is generated in `generate_function`
(functions/generation.yo) when `get_shell_redirect(func_id)` is Some. This makes
both ids resolve to the real body without duplicating the FuncVal, and avoids the
adoption regression (non-forward sites keep using the real id/cname directly).
Validate corpus 77/77 + lexer + parser. Note parser.yo is HEAVY (36 errors across
several recursive methods) — expect more after this.

**DONE (commit c4927b8e7): forward-shell THUNK.** shell_func_id→real_func_id
(Strings) recorded at impl.yo's shell-update; `generate_function` emits the shell
function as a thunk forwarding to the real C name. get_program is now a clean thunk;
corpus 77/77, lexer clang-clean. parser.yo 36→34. REMAINING 34 = a broader wave:
control-flow-as-value (`if`/`while`/`cond` returning values; init-assignments of
match/cond results) in the heavy parser functions (parse_template_string /
parse_expression) "Failed to transpile" — a codegen gap in those constructs (not
forward-shells). NEXT: pick one failing `if`/`while`/`cond`-as-value statement,
find why generate_other_function_call / the dispatcher returns None for it, fix.

**PINPOINTED (2026-06-20):** the failing functions are REAL, mostly-transpiled
bodies (e.g. yo_id_12129 — a parse method — emits proper switch/vtable C), NOT
shells. Within such a body, codegen transpiles fine up to a point, then EVERY
subsequent statement in the begin-block "Failed to transpile" (cascade). The
TRIGGER (first failure) is an `if`-AS-STATEMENT whose `begin` body contains an
early `return`, e.g.:
`if(next_tok_kind == TokenKind.RParen, begin(unit_tok := …, return(ParseResult(…)), ()))`
Everything after it (`pr := self.parse_expression(…)`, `(expr : AstExpr) = pr.expr`,
`idx := pr.index`, the next `if(curr_kind == …, begin(return …))`) is then dumped
as "Failed to transpile". So the gap is codegen for a CONDITIONAL EARLY-RETURN
inside a begin-sequence (`if(cond, begin(…, return(x), ()))` as a statement) — the
dispatcher returns None for that `if`, and the block's remaining statements
cascade. (Note: the recursive calls inside — parse_expression — are fine, they're
thunks now.) early_return.yo (corpus) covers a simple early return, so the gap is
the if+begin+return-in-sequence shape specifically. NEXT: build a minimal repro
(`fn → if(cond, begin(stmt, return(v), ())); more_stmts`), find why the
if-statement codegen / block emitter drops it, fix. Likely many of parser's 34
errors share this root.

**REPRO RESULT (2026-06-20): the simple shape does NOT reproduce.** A minimal
`classify :: fn(n:i32)->i32 ({ if(n==0, begin(x:=99, return(x), ())); y:=n+1; y })`
compiles cleanly under BOTH TS and yo-self-bin (0 transpile errors, runs correct).
So the trigger is NOT the conditional-early-return shape per se. The parser's
failing statement is more specific: `if(next_tok_kind == TokenKind.RParen,
begin(unit_tok := Token(...), return(ParseResult(expr : .FnCall(self.alloc_id(),
box(.Atom(...)), ArrayList(AstExpr).new(), false, tok), index : ...)), ()))` — it
constructs a `ParseResult` wrapping a runtime `.FnCall(...)` AstExpr enum, with an
`enum ==` condition, inside a large function (switches, many locals). And the
CASCADE (every statement after the first failure has NO transpilation) strongly
suggests the body's EVALUATION bailed partway — a swallowed def-time eval error at
that statement leaves the REST of the body without ExprInfo, so codegen emits
"Failed to transpile" for each. So the likely root is an EVAL error (not pure
codegen) in that ParseResult/.FnCall construction (e.g. the runtime AstExpr enum
construction, or the ParseResult struct with an AstExpr field), swallowed by the
def-time-body-eval trial wrapper. NEXT: repro the ParseResult/.FnCall construction

- enum-== in a struct-returning fn with a conditional early return; or instrument
  the def-time body eval to surface the swallowed error for yo_id_12129's body.

**CORE CYCLE CRASH FIXED (2026-06-20, commits a822b16dd + 6ec332472).** The
self-host stack-overflow (rc=138) is resolved: `derive(TypeValue, Clone)` is
replaced with a manual cycle-aware clone (path-based `g_tv_clone_path` guard on
the `EnumT` arm; on a self-reference it returns the FULL enum with SHARED
variant_fields — finite, collectable). Validated: corpus 77/77 zero diffs;
yo-self-bin builds clean; lexer.yo no longer crashes rc=138. `EvalValue` clones
fixed transitively. See `yo-self-phase6-stage2-crash-root.md` (memory) for the
full diagnosis chain that led here (disproved the "memory wall"; eliminated
compare/substitute/enum-finalization by test).

**REMAINING (now reachable since the cycle is fixed):** lexer.yo reaches CODEGEN
and aborts (rc=134) on a SEPARATE pre-existing collection gap:
`get_type_string: no C type name found for <enum:enum_yo_id_5628> (type not
collected before lowering)` — an enum (empty name, id 5628) referenced during
lowering but never registered in `context.types` by the codegen type-collection
pass (collect_type, codegen/types/collection.yo). This is the same CLASS of
per-module codegen gap fixed for token.yo (true/false, enum-monomorphization,
enum `==` dispatch), not the cycle.

**IDENTIFIED (2026-06-20): enum_5628 = `Option(Dyn(Error))`** — the
self-referential std `Error` trait type (`Error.source : fn(self : Self) ->
Option(Dyn(Error))`), used by lexer.yo via `std/error`. type_key:
`enum_yo_id_5628_dyn((source : fn(self : Self : (ToString)) -> <enum:enum_yo_id_5628>) + ToString)`
(self-ref, depth-capped). So this is ANOTHER manifestation of cyclic types — now
in CODEGEN collection/keying, not the clone.

**TWO fixes attempted + reverted:**

1. Resolve enum shells in `type_key` — no effect (the cycle-clone no longer emits
   shells; and the compiler's TypeValue isn't in g_enum_finals at this runtime).
2. Add an `is_dyn_type(ft) => ()` case to `_enum/_struct_some_type_is_only_in_
function_fields` (collection.yo) — a Dyn field IS ABI-concrete (fat pointer),
   so it shouldn't block collection; TS passes the filter because it RESOLVES
   `Self` (yo-self's Gap 6 leaves it unresolved). But this REGRESSED the corpus
   (SELF-FAIL 1) — collecting a previously-skipped Dyn-bearing type broke a
   fixture. Reverted.

**RESOLVED (2026-06-20, commit 1a0366a50): it was a COLLECTION-WALK gap, not
keying.** A diagnostic proved `collect_type` was NEVER called on
`Option(Dyn(Error))`. Root: `collect_type`'s `TraitT` case walked method field
types via `recur` = `collect_type(Func)`, which ERASES the Func and never collects
its return type — so `Error.source`'s return `Option(Dyn(Error))` (lowered when
emitting the `Dyn(Error)` vtable) was never registered. Fix: the TraitT case now
walks a method `Func`'s param + result types directly (register-before-recurse
breaks the Error→source→Error cycle); plus the enum some-type filter treats a
`Dyn` field as ABI-concrete so `Option(Dyn(Error))` is not skipped. **lexer.yo now
self-compiles with ZERO transpile errors and emits C.** Corpus 77/77, token.yo
clean.

**REMAINING (newly reachable — the emitted C does not yet clang-compile):** 8
clang errors in the `Dyn(Error + ToString)` VTABLE codegen:

- 6× `no member named 'throw' in struct __yo_dyn_(Error + ToString)_vtable_s` —
  codegen emits a `.throw` vtable access, but the Error/ToString vtable has only
  `source` + `to_string` (`throw` is an `Exception` method, not Error) → a
  Dyn method-DISPATCH confusion (Exception vs Error vtable) in the error-handling
  lowering.
- 1× undeclared `__yo_wrap_<concrete>_source` — the concrete error type's
  `source` method WRAPPER is not generated (only `to_string`'s is).
- 1× incompatible fn-ptr type initializing the vtable `source` slot.
  These are distinct Dyn-vtable codegen gaps specific to the self-referential Error
  trait (`source : fn(self) -> Option(Dyn(Error))`) + Exception handling — a deeper
  codegen layer, the NEXT step for the per-module self-host (lexer.yo → parser.yo →
  evaluator/codegen modules → main.yo).

**ROOT of the 6× `.throw` errors (2026-06-20):** `Exception` (std/error.yo:20) is
a STRUCT with a `throw : ctl(forall(ResumeType), error : AnyError) -> ResumeType)`
field — so `exn.throw(dyn(LexerError(...)))` is an ALGEBRAIC-EFFECT handler call
(the `throw` ctl), NOT a method call. Codegen misgenerates it as a Dyn
method-DISPATCH on the ARGUMENT: the emitted C is
`temp.vtable->throw(temp.data)` where `temp` is the `dyn(LexerError)` arg cast to
`Dyn(Error + ToString)` — i.e. it calls `.throw` on the error-arg's vtable (which
has only `source`/`to_string`, no `throw`) instead of invoking `exn`'s `throw`
ctl handler. So the effect-handler-call codegen for a `ctl` STRUCT FIELD picks the
wrong receiver when the effect's argument is itself a `Dyn`. The corpus effect
fixtures (effect_handler_unwind/resume, in the green 77) throw non-Dyn args, so
this Dyn-arg variant is unexercised.

**THROW DISPATCH FIXED (2026-06-20, commit fcdb0d944): clang errors 8 → 2.** The
Dyn method-dispatch path now also requires the DOT-RECEIVER (`exn`) to be a Dyn,
not just `dm_runtime[0]` (which for the ctl-field call was the dyn ARGUMENT). All
6 `.throw` errors gone; corpus 77/77 (incl. dyn_dispatch.yo).

**REMAINING 2 errors — trait-DEFAULT-method not modeled (structural Gap):** the
`Dyn(Error+ToString)` vtable references `__yo_wrap_<LexerError>_source`, but that
wrapper is never emitted — `generate_dyn_wrapper_functions` (functions/dyn.yo)
emits `/* Warning: Module field source is not a function value */` because the Dyn
EVIDENCE has `None` for `source`. Root: `Error.source` has a DEFAULT impl
(`(source : ...) ?= ((self) -> .None)`, std/error.yo:7); `LexerError` doesn't
override it. `_resolve_dyn_trait_values` (evaluator/values/dyn.yo:39) gathers a
type's trait methods from `get_type_trait_methods_for_type` and finds NO `source`
entry (defaults aren't registered as the type's methods) → `None`. yo-self's
`TraitT` does NOT store per-field default values (explicit divergence noted at
trait_type.yo:6-8: "TraitT has no defaultValueExpr/defaultValue per field"). FIX
(structural, deeper — defer to a focused pass): model trait method defaults —
store each defaulted method's default FuncVal (keyed by trait id + field label,
populated when the `trait(...)` is evaluated) and, when a type impls the trait
WITHOUT overriding a defaulted method, register the default as that type's method
(so `_resolve_dyn_trait_values` and normal dispatch both find it). Then the
`source` wrapper is emitted and the fn-ptr type resolves. HIGH-VALUE: trait
defaults are pervasive (Error, many std traits); this unblocks every module using
`std/error` (lexer/parser/evaluator/codegen all do). Validate corpus 77/77 + std

- token/lexer after.

**TRAIT DEFAULTS NOW MODELED (2026-06-20, commit f9c2b4140).** Added a
trait-default registry (type_trait_methods.yo: register_trait_default /
get_trait_default, keyed `trait_id::label`); the trait evaluator records each
`?=` default's FuncVal (trait.yo); `_resolve_dyn_trait_values` falls back to it
when a type omits a defaulted method (dyn.yo). The "Module field source is not a
function value" warning is GONE — the Dyn(Error) evidence now carries `source`
and its vtable wrapper IS emitted. Corpus 77/77, token.yo clean.

**REMAINING (lexer.yo: 8 → 3 clang errors): default-LAMBDA codegen-readiness.**
The emitted wrapper now calls the default's func (`fn_..._5629` = `(self) -> .None`),
but:

- `call to undeclared function 'fn_..._5629'` — the default lambda's body is
  referenced but not generated. `collect_required_functions` DOES walk the
  TraitVal evidence (functions/collection.yo:656), so the default FuncVal is
  reached; the gap is that the default lambda (comptime-evaluated in the trait
  def) lacks a registered Func TYPE / collectable body — codegen skips emitting
  it. Needs: register the default lambda's func type + ensure its body is
  collected/generated (or generate the trivial `-> .None` wrapper inline).
- 2× result-type mismatch: the default returns `Option(Dyn(Error))` but the
  wrapper/vtable slot types disagree (the self-referential enum's C type vs the
  int the body returns) — align the default wrapper's return type with the
  vtable slot.
  This is the NEXT step for lexer.yo; then parser/evaluator/codegen modules → main.yo.

**DEFAULT-LAMBDA FIX DEPTH CONFIRMED (2026-06-20):** the filled default
(`(self) -> .None`, func*id e.g. fn*...\_5629) is GENERIC over `Self`. Two facts
make this a full-monomorphization job, not a quick patch:

- Collection skips it: `_is_generic_unspecialized_func(fv)` (functions/
  collection.yo:526) keys off `get_func_type(func_id)` — the REGISTERED type,
  still generic (`Self`) — so even substituting Self in the evidence copy does
  not change what collection sees → the body is never generated (undeclared
  `fn_..._5629`).
- The result type stays `Option(Dyn(SelfTrait))`; `_substitute_self_in_method_ty`
  (impl.yo:1103) fixes the TYPE but not the body/collection.
  So the default must be MONOMORPHIZED: produce a NEW func_id with concrete
  type + body (Self→concrete), register its func type, and let collection emit it
  — i.e. route the default through `create_specialized_function_inline` (helper.yo)
  with `ArgValues` for `self : concrete`, at the point it's filled into the Dyn
  evidence (`_resolve_dyn_trait_values`, which would need `ctx`/caller_env
  threaded in — its 2 callers both have `ctx`). Substantial integration; high
  value (every `std/error` user — lexer/parser/evaluator/codegen). Validate corpus
  77/77 + token/lexer after.

**CYCLE-AWARE CLONE COMPLETED (commit 7b2862f68): EnumT + STRUCT.** The clone now
guards self-referential structs too (was EnumT-only). **main.yo (UNIFIED load)
status:** still rc=138 at 8 GB, still in `get_specialized` — but with clone now
fully cycle-guarded, the remaining unified-load loop is in `substitute` and/or the
structural compare (`_compat_impl`) traversing cyclic types (NOT clone). Those
have their own (tested-but-reverted) guard sketches; the unified main.yo ALSO
remains memory-heavy. STRATEGIC NOTE: the PER-MODULE self-host path (compile each
module, link) is memory-feasible and is the pragmatic route — lexer.yo is at 3
clang errors (default-lambda codegen) on it; finish lexer → parser → evaluator →
codegen modules, rather than chasing the unified main.yo (deeper memory + multiple
cyclic-traversal spots). The cycle-aware clone (this session's keystone) is the
shared foundation both paths needed.

OPEN (2026-06-19). Phase 5 is DONE (parallelism keystone + Thread.spawn work
end-to-end, corpus 76/76, commit 88d060546). Phase 6's first step — the stage-2
self-compile (`yo-self-bin compile yo-self/main.yo`) — crashes before producing C.

## BREAKTHROUGH (2026-06-20): the crash is a FIXABLE specialization-recursion bug, NOT a memory wall

An **overflow-surviving depth probe** (a temporary global counter in
`_evaluate_expression` that `eprintln`s — and thus flushes — each new maximum
depth) overturned the long-standing "memory wall / needs 24 GB" diagnosis for
PER-MODULE compiles:

- **token.yo** self-compiles to clean C now (after the runtime-operator-dispatch
  fix, commit 590735ea3); peak eval-depth 105.
- **lexer.yo** crashes (rc=138) at eval-depth **107 — IDENTICALLY at 2 GB, 6 GB,
  and 8 GB stacks**. Stack exhaustion scales with stack size; a stack-INVARIANT
  crash depth does not.
- The env var IS honored: token.yo @256 MB crashes at depth 33, @1 GB succeeds at
  max 105 (~8 MB/eval-level). So at 8 GB the eval ceiling is ~1000 levels —
  eval-depth 107 is NOT the eval ceiling. The crash is a SEPARATE, stack-invariant
  (effectively unbounded/cyclic) recursion triggered AT eval-depth 107.

**Crash site (lldb):** frame #0 = `ArrayList(TypeValue).get` (mangled
`fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList(TypeValue)`),
faulting in its PROLOGUE (giant frame — returns `Option(TypeValue)` by value, and
`sizeof(TypeValue)` is enormous). lldb can only unwind 2 frames (prologue crash).

**Trigger (probe token trace):** depths 92-100 = a repeating `n`/`usize`/`usize`
3-cycle = the `__yo_comptime_fold_range` `n - usize(1)` recursion = the DERIVE
machinery unrolling once per enum variant (the CLAUDE.md derive(Eq)-fold-range
pitfall); then `.variants`/`.`/`v`/`a`/`lhs` = a derived `==` executing at
comptime. So lexer.yo's compile runs derive comptime-folding →
`create_specialized_function_inline` (helper.yo:993), which **deep-clones** the
callee's TypeValues (the auto-generated `clone_specialized_T_TypeValue`, ≈half of
round-3's `sample` profile), iterating an `ArrayList(TypeValue)` via `get` and
recursing unboundedly over a pathological/cyclic TypeValue → overflow in `get`.
(Note `type_to_string`/`_tts` is NOT the culprit — `_tts` already has a depth-40
guard, `types/string.yo:20`; the unguarded recursion is the CLONE.)

**Root (CONFIRMED 2026-06-20):** `create_specialized_function_inline` deep-CLONES
TypeValues with no cycle guard, and the cyclic type is **the compiler's own
recursive `TypeValue` enum**. Chain: instrumenting create_specialized's entry
shows the last specialization before the crash is a generic over
`Bucket(String, FuncCapturedVarInfo)` (the capture-analysis HashMap's bucket).
`FuncCapturedVarInfo` (closure.yo:59) has a field `ty : TypeValue` (and
`value : Option(EvalValue)`). To specialize over that bucket, the clone descends
into the field type `TypeValue` — which AS A TYPE is an `EnumT` whose own variants
hold `Box(Self)` (`Pointer(pointee: Box(Self))`, `result: Box(Self)`, etc.,
definitions.yo:63/70/93) ⇒ a **self-referential EnumT**. Deep-cloning it recurses
forever (iterating each variant's `ArrayList(TypeValue)` field via `get` — the
crash frame). TS shares the EnumT reference (a cycle in the object graph that is
never deep-cloned), so it never loops. token.yo self-compiles because it never
specializes a generic over a `TypeValue`-bearing type; lexer.yo is the first
module whose compilation does (via the capture-analysis `HashMap`). Same class as
the `substitute()` self-referential-trait cycle bug already fixed
(`yo-self-substitute-cycle-guard`, commit 9b67b199), but in the clone-during-
specialize path.

**REFINED (2026-06-20, tested): the recursion is the auto-CLONE, not the compare.**
Added a backstop in `_compat_impl` (the structural type-comparison core,
compatibility.yo:101) bailing to `false` when its shared `visited` list (ArrayList
is `object` ⇒ passed by reference, so it DOES accumulate) exceeds 1000 — under
`require_exact` only. Rebuilt; lexer.yo STILL crashes rc=138 in the SAME frame
(`ArrayList(TypeValue).get`), and the cap never changed behavior ⇒ the comparison
is NOT the unbounded recursion. Reverted the backstop (ineffective). Therefore the
loop is the **auto-generated `clone` of `TypeValue`** (`clone_specialized_T_TypeValue`,
≈half of round-3's sample), which has no cycle guard, cloning the inherently-cyclic
`TypeValue` EnumT (variants hold `Box(Self)`). `spec_ret_ty.clone()` in
create_specialized (helper.yo:1116/1125/1165/1205) and/or the specialized body's
type substitution clone the return/param type, which for the culprit (`yo_id_3835`
over `Bucket(String, FuncCapturedVarInfo)`) transitively contains `TypeValue`.
Can't just drop the `.clone()`: `TypeValue` is a value-type enum, so the multiple
uses genuinely need copies (move semantics).

**ALSO TESTED + REVERTED (2026-06-20): a `substitute` cycle guard.** Added a
path-based (push/pop) `visited_type_ids` guard to `substitute`'s `EnumT` and
`Struct` arms (substitution.yo), mirroring the existing `visited_trait_ids`
TraitT guard, so substitute returns a self-referential struct/enum unchanged on
the recursion path. Rebuilt; lexer.yo STILL crashed rc=138 in the same
`ArrayList(TypeValue).get` frame. Reverted (ineffective). With BOTH the
comparison (`_compat_impl`) and `substitute` guards now ruled out by test, the
unbounded recursion is **purely the auto-generated `derive(Clone)` of an
already-cyclic `TypeValue`** — the cycle exists in the input value before the
clone, and the generated clone (no cycle guard, not user-editable) loops on it.
Neither a compare-side nor substitute-side guard helps because neither is on the
loop. The fix must therefore break the cycle EARLIER (where the recursive type's
self-reference is materialized as a full back-edge instead of a finite-DAG
shell — recursive types are normally shells, so some path during lexer.yo's
specialization resolves one to its full cyclic form) OR replace the specific
`.clone()` of that type in the specialization path with a manual cycle-aware
clone. Both are blocked on PINPOINTING the exact site: lldb only unwinds the 2
prologue frames of the overflow, and the clone is compiler-generated (not in
source to instrument). NEXT TOOLING STEP: instrument `resolve_enum_shell` /
`resolve_recursive_type_ref` / the enum-definition materialization to print when
a recursive self-reference is expanded to its full form during lexer.yo's
compile, to catch where the cycle is created.

**RULED OUT (static analysis): enum finalization is NOT the cycle source.**
`evaluate_enum_type` (enum.yo:662-706) builds the finalized EnumT as a FINITE
one-level DAG: `_patch_self_shell` (enum.yo:180) replaces a self-shell with
`pre_final_ty` ONE level deep, and `pre_final_ty`'s own self-fields stay SHELLS
(empty variants); deeper nesting resolves lazily via `resolve_enum_shell`
(creators.yo:333). So a derived `clone` of the finalized enum is bounded. The
true cycle must form later — when something eagerly RESOLVES the inner shells in
place (each `resolve_enum_shell` returns the full `pre_final_ty`, whose inner is
again a shell that resolves to the full…), producing an unboundedly deep / truly
cyclic value that the derived clone then loops on.

**GLOBAL FIX CANDIDATE: replace `derive(TypeValue, Clone)` (definitions.yo:323)
with a MANUAL cycle-aware `Clone` impl** that, on revisiting a type id already on
the clone path, emits a shell (empty-variant EnumT / empty-field Struct) instead
of recursing. This fixes EVERY `.clone()` site at once (sidesteps having to
pinpoint the specific one). HIGH RISK: `clone` is fundamental and called
everywhere; the manual impl must be byte-for-byte equivalent to the derived clone
for all NON-cyclic types or it regresses the whole compiler. Requires careful
implementation + full validation (corpus 76/76 + check ./std 151/151 + check
./yo-self 227/227) in a focused session. Same idea applies to `EvalValue`.

**THIRD FIX TESTED + REVERTED (2026-06-20): `substitute`-normalize `spec_ret_ty`.**
Re-added the `substitute` cycle guard (`visited_type_ids`, path-based push/pop on
EnumT/Struct) AND normalized `spec_ret_ty` via `substitute(subst_new(), …)` in
`create_specialized` (a cycle-safe structural clone) before the 4 derived
`.clone()` sites. Rebuilt; lexer.yo STILL crashed rc=138. Reverted. CONCLUSION:
the crashing derived clone is NOT `spec_ret_ty.clone()` — it is in the
SPECIALIZED-BODY EVAL (helper.yo ~1209+), which clones the cyclic type at one of
the evaluator's many `.clone()` sites (param/arg types, EvalValues carrying
TypeValues, etc.). Normalizing individual sites is whack-a-mole and does not
scale.

**THE ONLY SCALABLE FIX (next session — large + must validate hard): replace
`derive(TypeValue, Clone)` (definitions.yo:323) with a MANUAL cycle-aware clone.**
This fixes EVERY `.clone()` site at once, including `EvalValue` clones TRANSITIVELY
(derived `EvalValue.clone` delegates to its fields' `.clone()`, so a cycle-aware
`TypeValue.clone` makes `EvalValue.clone` bounded too — no separate EvalValue fix
needed). Recipe:

- Add `_clone_tv :: (fn(t : TypeValue, visited : ArrayList(String)) -> TypeValue)`
  in definitions.yo (it already imports ArrayList; `box`/`Option` are prelude).
  Mirror `substitute`'s variant-by-variant structure (substitution.yo:93-339) but
  with NO substitution — just reconstruct each variant, using `recur(child,
visited)` for `Box(Self)` and inline loops with `recur` for `ArrayList(Self)` /
  `ArrayList(ArrayList(Self))`; `.clone()` the non-TypeValue lists
  (ArrayList(String)/usize/bool/i64). 39 variants; the first ~22 are fieldless
  leaves (reconstruct directly). Field ORDER must match definitions.yo EXACTLY
  (esp. `Func`'s 17 positional fields).
- On EnumT/Struct: `cond(((id.len()>0) && _path_visited(visited, id)) => <SHELL
with same id+name, empty variants/fields>, true => { visited.push(id);
<reconstruct with recurs>; visited.pop(); <full> })`. Path-based push/pop so
  sibling repeats of a generic type still fully clone; only a type containing
  ITSELF on the path collapses to a shell (which resolve_enum_shell re-expands).
- Replace `derive(TypeValue, Clone)` with `impl(TypeValue, Clone(TypeValue),
clone : (fn(ref(self) : TypeValue) -> TypeValue)(_clone_tv(self,
ArrayList(String).new())))`.
- VALIDATE before commit: `bun run build`, diff-test corpus (76/76), `check
  ./std` (151/151), `check ./yo-self` (227/227), then `compile yo-self/lexer.yo`
  (must produce C, no rc=138), then ideally `compile yo-self/main.yo`.
  RISK: the manual clone must be byte-equivalent to the derived one for all
  ACYCLIC types (the guard never fires there). A single wrong field silently
  corrupts the compiler — hence the full validation sweep is mandatory, which is
  why this is a focused-session task, not an end-of-session change.

**NEXT FIX (focused; must keep corpus 76/76 + std 151):** 0. The compat backstop, the substitute guard, AND spec_ret_ty normalization are
all NOT the fix (three tested-ineffective attempts). Enum finalization is ruled
out (finite DAG). The crash is the derived clone in the specialized-body eval.
THE fix is the global manual cycle-aware `TypeValue.clone` recipe above. The fix is a
cycle-aware CLONE of `TypeValue` used by the specialization path: a manual
`clone_type_acyclic(t, visited)` that deep-clones but, on revisiting a
type id already on the path, returns a shell/leaf (mirroring how
`resolve_recursive_type_ref` keeps recursive refs as finite-DAG leaves), then
use it for `spec_ret_ty` and any specialized param/body type clone. (Or, like
TS, restructure so recursive EnumTs are never deep-cloned at all.)

1. Identify the exact pathological/cyclic TypeValue lexer.yo's derive-fold
   instantiates — instrument the clone / `create_specialized_function_inline`
   entry with a depth-guarded type print (bail+print past depth ~200 to survive).
2. Either (a) avoid the deep-clone (share/reuse the TypeValue ref like TS where
   the specialization doesn't actually substitute that sub-type), or (b) add a
   visited-set cycle guard to the TypeValue clone used by specialization. Prefer
   the narrowest change that breaks the cycle without altering specialization
   identity (a blind depth-cap on clone risks producing distinct-but-equal
   specializations → cache anomalies; std 151→17 regressed on a cache-key edit
   before).
3. Validate: corpus 76/76 (diff-test), `check ./std` 151/151, then re-run
   `yo-self-bin compile yo-self/lexer.yo` (should produce C, no rc=138).

## Symptom

- `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin compile yo-self/main.yo` (the -O0 binary):
  rc=138 (SIGBUS), ZERO output.
- `YO_MAIN_STACK_MB=16384 ... check yo-self/main.yo` (-O0, eval-only, 16 GB stack):
  rc=138, zero output → the crash is in EVAL/module-load of the full self-source,
  not codegen-specific.
- `YO_MAIN_STACK_MB=8192 /tmp/yo-self-rel compile yo-self/main.yo` (the **--release**
  binary, -O2 small frames): STILL rc=138, zero output.

## Key conclusion: NOT (just) deep-recursion stack exhaustion

CLAUDE.md attributes the rc=139/138 deep-recursion crash to -O0 multi-MB frames and
prescribes `--release` (LLVM stack coloring, ~100× smaller frames → 1000s of levels).
Here the **--release binary crashes identically** (rc=138, 8 GB stack), so it is NOT
stack depth — it is a GENUINE crash (null/misaligned access, or a memory/resource
limit manifesting as SIGBUS) triggered by loading+evaluating the ENTIRE self-source
graph in one process. (The --release binary is otherwise healthy: it compiles +
runs the spawn repro → `thread sees 42` / `main done`.)

Note `check ./yo-self` (Phase-3 milestone, 227/227) checks each file in ISOLATION;
`check yo-self/main.yo` loads main + ALL transitive imports together — the harsher
unified load is what crashes.

## lldb backtrace (2026-06-19) — pinned to `get_specialized` frame

`lldb -b -o run -o bt -- /tmp/yo-self-rel compile yo-self/main.yo`:

```
thread #2, stop reason = EXC_BAD_ACCESS (code=2, address=0x300003ff0)
frame #0: fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList_(enum(Unit,BoolT,Void,Str,Int(...),Float(...),...,Pointer(Box(enum(...))),Array(Box(enum(...)),length,length_var))...)  +4
->  stp x24, x23, [sp, #0x10]   ; (function PROLOGUE — store to the stack)
```

The fault is a WRITE (code=2) at a stack-pointer-relative store in the function
PROLOGUE → a STACK OVERFLOW, in `get_specialized` specialized over the GIANT nested
`TypeValue` enum (the `Self` = `ArrayList(enum(... the whole TypeValue ...))`). It
runs on thread #2 (the `__yo_main_stack` worker that runs `main`; YO_MAIN_STACK_MB
applies to it), yet 8 GB overflowed at --release — so this is NOT ordinary
deep-recursion-with-small-frames. Likely cause: `get_specialized`'s frame holds the
giant `TypeValue`/`ArrayList(enum…)` BY VALUE (a multi-KB+ frame even at -O2), and it
recurses over the deeply self-referential `TypeValue` (`Box(enum(...Box(enum...)))`),
so a moderate depth × giant frame blows the stack — OR it is genuine unbounded
recursion in `get_specialized` for this self-referential type. NOTE: `get_specialized`
(types/...:id_121, the `Type.get_specialized` method) is unrelated to the closure work
— this is a pre-existing self-compile gap surfaced by the harshest input.

## Diagnosis directions (next session)

0. Pin whether it's unbounded vs deep-but-finite. ATTEMPTED: `lldb bt 200` shows only
   frame #0 — lldb cannot unwind past the overflowing prologue (the frame isn't
   established), so depth is hidden. Next: set a breakpoint on `..._get_specialized`
   with a counter, or instrument the Yo `get_specialized` source with a depth guard
   that panics at N to confirm recursion. Inspect the `Type.get_specialized` source
   (types/...:id_121, a generic method specialized over the self-referential
   `TypeValue` enum): look for (a) a missing cycle/base case when recursing the
   self-referential type, and (b) the giant `TypeValue`/`ArrayList(enum…)` passed/
   returned BY VALUE (multi-KB frames) — box it / pass by ref to shrink frames.
   8 GB overflowing at --release points to deep-or-unbounded recursion over the
   self-referential type, OR giant frames × moderate depth.

1. The empty output is the main obstacle. Force-flush / run under a debugger:
   - `lldb -- /tmp/yo-self-rel compile yo-self/main.yo` → backtrace at the SIGBUS;
     `MallocStackLogging=1` / `MallocScribble=1` if it's a heap/UAF.
   - Check Console.app / `~/Library/Logs/DiagnosticReports` for the crash report
     (signal, faulting address, frame).
2. Bisect by input size: `check` progressively larger SUBSETS of the import graph
   (e.g. a driver that imports only lexer+token+parser, then + evaluator, then +
   codegen) to find the module/threshold that triggers it. Distinguishes
   memory-pressure-scales-with-size from a specific-module bug.
3. Rule out OOM/mmap: watch RSS during the run; if it balloons then SIGBUS, it is
   memory pressure (SIGBUS from a failed lazy page-in), not a logic bug.
4. If a specific construct: minimize to a standalone repro (the usual issues/
   workflow) and fix the evaluator/loader.

## UPDATE — 32 GB stack → OOM-kill (rc=137): NOT fixable by more stack

`YO_MAIN_STACK_MB=32768 /tmp/yo-self-rel compile yo-self/main.yo`: rc=137 (SIGKILL =
OS OOM-kill). So at 8 GB it stack-overflows (rc=138) and at 32 GB it exhausts RAM
before finishing → the recursion is pathologically deep (or unbounded). More stack is
NOT the fix.

The crash frame (`get_specialized` = the SPECIALIZED `ArrayList.get`; C comment:
`(ArrayList(u8)) fn(self, index) -> Option(u8)`) is `ArrayList(TypeValue).get →
Option(TypeValue)` — `Option(TypeValue)` is returned BY VALUE, and `TypeValue` is the
huge self-referential enum, so each such frame is large. `get` itself isn't recursive;
it's just where the already-near-exhausted stack tips over during a deep evaluator
recursion (lldb couldn't unwind the caller chain past the overflow).

Important contrast: `check ./yo-self` (Phase-3, 227/227) checks each file in ISOLATION
and is fine; `check`/`compile yo-self/main.yo` loads main + ALL transitive imports in
ONE evaluation, and THAT unified eval recurses deeply enough to exhaust 32 GB. This
smells like either (a) a missing memoization/cycle-guard so a shared self-referential
type (TypeValue) is re-descended combinatorially in the unified load, or (b) a genuine
unbounded recursion triggered only by the full graph, or (c) just-too-deep × the giant
`TypeValue`-by-value frame cost.

### Refined fix directions

1. Determine bounded-vs-unbounded: instrument the hot evaluator recursion (or
   `ArrayList(TypeValue).get`'s caller) with a depth counter that panics at e.g. 5000
   — a panic with a clean Yo stack trace shows the recursive cycle; no panic before
   OOM = genuinely deep, not a single tight loop.
2. Shrink the per-frame cost: `TypeValue` is large + returned/passed by value in
   hot recursive paths (e.g. `Option(TypeValue)` returns, `clone`, `match` temps).
   Boxing more of TypeValue (or returning `*(TypeValue)` in the hottest helpers)
   cuts frame size ~Nx and may bring depth back under a sane stack.
3. Add memoization/cycle-guards to whatever traverses the self-referential TypeValue
   in the unified load (mirrors the substitute() / type_contains cycle guards already
   added elsewhere this port).

### UPDATE — scales with unified-load size (not main.yo-specific)

`YO_MAIN_STACK_MB=4096 /tmp/yo-self-rel check yo-self/codegen/codegen_c.yo` (a large
SUBGRAPH — the whole codegen + evaluator, less main's full graph) ALSO crashes rc=138,
0 "evaluator OK". So the deep recursion is NOT a single main.yo-only construct — it
triggers on any sufficiently large unified load and scales with graph/type count. Small
isolated files (`check ./yo-self` per-file, 227/227) are fine. → strongly favors a
combinatorial re-descent of shared self-referential types (missing memoization in a
type-traversal run per-module during the unified load) and/or genuinely-deep def-time
body-eval recursion across the full call graph, amplified by the giant
`TypeValue`-by-value frame cost. The fix is frame-size reduction (box TypeValue in hot
paths) + memoization/visited-guards on the type traversal, not more stack.

### UPDATE — rebuild-free diagnostics exhausted (both lldb directions blocked)

- `lldb bt` cannot unwind past frame #0 (the overflow faults at the prologue before
  the frame/FP chain is established).
- `lldb memory read -f A -c 8000 $sp` returns only ~21 entries — reading UP the stack
  from `$sp` immediately hits the guard page / unmapped region (the deep frames are in
  the exhausted area), so the repeating-return-address scan can't see the recursion.

So pinning the EXACT recursive function needs depth instrumentation, and a naive
global counter is unreliable here: the def-eval-wall unwinds frequently (trial-eval
swallow), and `unwind` skips a decrement-on-exit → the count leaks upward across many
shallow evals and gives false depth. A correct probe must save/restore depth across
BOTH normal return AND the unwind handler (e.g. in `_evaluate_expression_wrapper`
\_expr.yo:898, the per-call exn handler restores `g_eval_depth = saved` before
`unwind`). With that, panic-at-N (on the descent) prints the recursive expr/construct.
Alternatively, address the SYMPTOM: shrink the per-frame cost by boxing/`*(TypeValue)`
in the hottest type helpers (e.g. `Option(TypeValue)` returns) so the same depth fits
— but TypeValue is pervasive, so that is a large, carefully-validated change.

### UPDATE — ruled out the obvious type-traversal recursers

The deep recurser is NOT a naive cyclic type traversal — the usual suspects are
already bounded/guarded: `type_to_string`/`_tts` (types/string.yo) caps at depth 40
(`_d > 40 → "…"`) and doesn't recurse Struct/Enum field types (prints the name);
`are_types_compatible` (compatibility.yo) has a `visited` cycle guard on
Struct/Union/Enum; `substitute` has the `visited_trait_ids` cycle guard. So the deep
recursion is in the EVAL / comptime-execution path (e.g. `_evaluate_expression`
mutual recursion or a comptime fn executing over the unified graph), not a tight
type-structure loop — consistent with the crash being where a deep eval chain happens
to call `ArrayList(TypeValue).get`. Next-session probe should target the eval
recursion (unwind-aware depth guard in `_evaluate_expression_wrapper`) rather than the
type helpers.

## BREAKTHROUGH (2026-06-19) — sampling profiler pins the REAL recursion

The lldb dead-ends were sidestepped with macOS `sample`, which snapshots the live
call tree _while the recursion is still descending_ (run with a big stack so it
doesn't crash mid-sample):

```
YO_MAIN_STACK_MB=16384 /tmp/yo-self-bin check yo-self/main.yo & PID=$!
sleep 3; sample $PID 4 -file /tmp/s.txt; kill $PID
```

**The `get_specialized` frame in the old lldb backtrace was a RED HERRING.** The
profiled hot recursion is the EVALUATOR's def-time body-eval path, not a type
traversal. Two facts from the sample:

1. The recursive cycle is:
   `_evaluate_expression → evaluate_function_call → try_to_call_function_with_arguments
→ … → _build_def_time_body_env → _trial_eval_fn_body (body eval) → _evaluate_expression`,
   with `synthesize_types`/`_synthesize_types_impl`, `try_to_implement_function_by_function_type`,
   `find_methods_from_generic_impls`, `get_variables_from_env`, `merge_and_check_envs`
   interleaved. So **def-time body eval is being RE-ENTERED** — evaluating one
   function's body triggers def-time body eval of further functions, descending the
   (cyclic) compiler call graph that only the UNIFIED load makes fully resolvable.
2. **~half the samples are `clone` / `clone_specialized_T_TypeValue_Self_ArrayList` /
   `…_Box`** — every `_build_def_time_body_env` copies the ENTIRE caller env's
   variables (function_type.yo:247-274 loops all frames × all variables, cloning each
   `cv.ty`), and in the unified load that env holds all modules' symbols. So each
   re-entry is a giant frame (huge env clone + TypeValue-by-value) AND the depth is
   the call-graph depth → GBs.

Why per-file `check ./yo-self` (227/227) is fine but `check main.yo` overflows: in
per-file isolation a cross-module callee is a shell/signature, so a call to it
type-checks via its return type; in the unified load the callee's full body is
present, so def-time body eval descends into it (and into ITS callees…).

## Fix lead — TS's `skipSpecialization` + `skipCtfeExecution` + checking-phase flag

TS breaks exactly this recursion (see `docs/SPECIALIZATION_CACHE_PITFALL.md`,
function.ts:885/945): when CHECKING a call it passes
`tryToCallFunctionWithArguments({ …, skipSpecialization: true, skipCtfeExecution: true,
context: { …, isInFunctionCallCheckingPhase: true } })` so the call's result type is
computed WITHOUT executing/specializing the callee body, and the
`isInFunctionCallCheckingPhase` flag PROPAGATES so nested calls also skip CTFE.

yo-self ports the pieces but does NOT honor one:

- `is_in_function_call_checking_phase` exists (context.yo:235), is set during trials
  (function.yo:534) and read in comptime_fn.yo:429. ✓
- `skip_specialization` is honored (helper.yo:2523 `if(!(skip_specialization) && …`). ✓
- **`skip_ctfe_execution` is DISCARDED — helper.yo:1816 `_ := skip_ctfe_execution;`.**
  The parameter is accepted and thrown away, so CTFE/body execution is NOT skipped
  during the checking phase. ✗ ← prime suspect.

NEXT: trace where `try_to_call_function_with_arguments` actually executes the callee
body (post-`synthesize_types`) and gate it on `skip_ctfe_execution ||
ctx.is_in_function_call_checking_phase` (mirroring TS). Also confirm every def-time
body-eval call site enters the checking phase with both flags true. Validate the
corpus stays 76/76 (the flag must not suppress execution that real CTFE needs) AND
that `check main.yo` no longer overflows. CAUTION: this gates comptime execution —
an over-broad gate will regress CTFE-dependent fixtures, so scope to the
checking-phase path only.

Secondary lever if depth persists: `_build_def_time_body_env` copies the whole env by
value every re-entry — share/alias it instead of deep-cloning (cuts frame size + the
clone half of the samples).

## UPDATE (2026-06-19, cont.) — two experiments, root narrowed to specialization-during-validation

Profiled `create_specialized_function_inline` IS in the hot recursion (21 frames in a
3 s sample), so the deep chain is GENERIC SPECIALIZATION. Two fixes attempted, BOTH
reverted (kept 76/76 clean):

1. **Skip def-time body validation during the checking phase** (gate
   `try_to_implement_function_by_function_type`'s body eval on
   `!ctx.is_in_function_call_checking_phase`). REVERTED: no effect — the flag is not
   set on the hot recursion path (the recursion is not reached via the
   checking-phase trial calls).

2. **Port the missing mutual-recursion stack guard.** yo-self's `is_recursive_spec`
   guard (helper.yo:2524) only checked the SINGLE slot `currently_specializing_function`,
   so MUTUAL recursion (f specializes g specializes f — the slot is overwritten by g)
   was not caught — only direct self-recursion. TS tracks the full
   `currentlySpecializingFunctionStack` and checks it with `.some(...)`
   (helper.ts:1852-1857, push/restore 2419-2469). I ported it (helper
   `_func_id_being_specialized` scanning the stack + push/pop the stack at the
   set/restore sites; stack entries need only `original_func_id` since yo-self has no
   stack-based forward-ref — `EvalValue` has no `.clone()`, so the entry's
   `original_func_value` was a `UnitVal` placeholder). RESULT: partial — the eval
   recursion shrank (`_evaluate_expression` 1659→966 samples) but the crash REMAINED,
   AND it regressed `runtime_numeric_cast.yo` to SELF-FAIL (75/76). So the
   mutual-recursion stack is NECESSARY (it is a real TS mechanism yo-self lacks) but
   INSUFFICIENT alone, and its naive form perturbs an existing specialization the
   numeric-cast fixture depends on.

**Refined root cause:** generic specialization (`create_specialized_function_inline`,
which deep-clones the callee env + TypeValues — the clone half of the samples) RUNS
during def-time body validation and recurses a deep chain of DISTINCT specializations
down the compiler's generic call graph. TS avoids this: while CHECKING a call it
passes `skipSpecialization: true` (+`skipCtfeExecution: true`, +
`isInFunctionCallCheckingPhase: true`) so the call's result type is resolved WITHOUT
specializing/executing the callee body. **yo-self DISCARDS `skip_ctfe_execution`
(helper.yo:1816 `_ := skip_ctfe_execution;`) and does not propagate
`skip_specialization` into the calls inside a body being validated**, so each call
fully specializes, cascading.

**Fix plan (do together, validate as one):**
(a) Honor the checking-phase intent: during def-time body validation, calls resolve
their return type via `synthesize_types` WITHOUT `create_specialized_function_inline`
— i.e. propagate `skip_specialization`/`skip_ctfe_execution` (or gate
specialization on `!ctx.is_in_function_call_checking_phase` AND not-validating)
exactly where TS sets them. Compare TS function.ts:885/945 + the
`isInFunctionCallCheckingPhase` propagation precisely.
(b) Add the mutual-recursion stack guard (experiment 2) for the genuine recursive
specializations that remain — but reconcile it with `runtime_numeric_cast.yo`
(understand why that fixture needs the specialization the stack guard suppressed;
likely the guard must still allow the FIRST specialization and only short-circuit
a re-entrant one with identical args).
(c) Secondary: shrink `_build_def_time_body_env`'s whole-env deep clone.
Validate: corpus 76/76 AND `check main.yo` no longer overflows (2 GB stack).

## UPDATE (2026-06-19, round 3) — two constraints that rule out the easy fixes

Investigated fix (a) and the env-share lever; both hit a wall that must be respected:

- **Cannot skip specialization during the def-time body trial.** The trial context
  (`create_function_body_evaluation_context`) SHARES `ctx.expr_info_table`
  (function_type.yo: `expr_info_table : ctx.expr_info_table`). So the def-time body
  eval is NOT throwaway — it is the single pass that populates the ExprInfo (incl.
  specialized callee FuncVals) that CODEGEN consumes. yo-self does validate +
  codegen-metadata population in ONE recursive pass over the call graph. Gating
  `create_specialized_function_inline` on `!is_validating_function_definition` (or the
  checking-phase flag) therefore breaks codegen for every generic call inside a body.
  This is the core reason the recursion can't simply be cut: the specialization chain
  IS the work codegen needs.

- **The env flat-copy is NOT a behavior-preserving target for `snapshot_env`.**
  `_build_def_time_body_env`'s copy (function_type.yo:247-274) does two things: the
  expensive O(unified-env) copy AND a re-bind that forces `is_compile_time_only =
(variable has a value)` (so valued module globals become comptime in the body env).
  `snapshot_env` (shallow frame share) would keep each variable's ORIGINAL
  `is_compile_time_only`, changing comptime/runtime classification in the body —
  load-bearing (see the std/log.yo `is_reassignable` note in-code). So the env-share
  win requires replicating the is_compile_time_only re-bind on the shared frames (or
  proving TS's variables already carry the right flag at definition and the re-bind is
  itself the divergence to remove).

**Net:** the genuine fix is a COORDINATED change — most likely (1) box/`*(TypeValue)`
the hottest by-value TypeValue paths to shrink the C stack frame so the deep-but-
necessary specialization chain fits (attacks rc=138 directly, the only lever that does
not fight codegen's need for the chain), plus (2) the env-share + is_compile_time_only
re-bind to cut the heap/OOM half, plus (3) the mutual-recursion stack + forward-ref
port for the cyclic specializations. Each needs its own validated rebuild cycle
(~13 min) and must keep the corpus at 76/76; this is a dedicated multi-iteration effort,
not a single rapid edit. Three fixes were attempted this session and ALL reverted to
preserve 76/76 — the working compiler must not be regressed for a partial fix.

## UPDATE (2026-06-19, round 4) — mutual-recursion fix landed; depth is huge/unbounded → suspect the spec cache

- **Mutual-recursion specialization guard + forward-reference PORTED & committed**
  (b2f62e781): yo-self lacked TS's `currentlySpecializingFunctionStack` + forward-ref
  (helper.ts:1985-2010) — it handled only DIRECT recursion (single slot + `recur`).
  Now the stack is pushed/popped around specialization and mutual recursion forward-
  refs the in-progress specialized funcId. Corpus 76/76 (runtime_numeric_cast.yo
  exercises it). **But this does NOT fix the stage-2 crash** — profiling the fixed
  binary shows `_build_forward_ref_funcval` is hit ZERO times on the crash path, so
  cyclic specialization is NOT the crash driver.

- **`--release` ALSO crashes (rc=138, 4 GB) — confirmed with a fresh -O2 build.** This
  rules out the "-O0 giant-frame" explanation: at ~100× smaller -O2 frames, a bounded
  ~514-deep chain (what a 3 s `sample` showed) would fit in well under 1 GB. Crashing
  at 4 GB (and 32 GB OOM, per above) means the recursion is genuinely **thousands deep
  or unbounded**, not deep-but-finite × big frames. The `sample` max-depth (~514) was
  an undercount (tree-merge / mid-descent snapshot).

- **Prime remaining suspect: specialization-cache MISS → re-descent.** Only GENERIC
  calls recurse during validation (non-generic calls resolve their return type from the
  signature without evaluating the callee body; `is_func_generic` gates
  create_specialized_function_inline). So the deep chain is generic specialization
  descending the call graph. With a working cache, each `(func, concrete-args)`
  specializes ONCE and repeats hit the cache — bounding the chain. If
  `_find_specialization_cache` / `compute_compile_time_signature` produces an UNSTABLE
  key for functions over the self-referential `TypeValue` (e.g. freshened type ids per
  specialization, or a key that varies for the same logical type), every repeat call
  re-specializes → unbounded re-descent. This is the OPPOSITE failure of the cache
  COLLISION fixed earlier (see memory yo-self-phase3-hashmap-new-blocker, where a
  name-only struct compare gave false HITS) — here we'd have false MISSES.

  NEXT: instrument `create_specialized_function_inline` to log `(func_id, signature)`
  on cache miss; if the SAME logical specialization recurs with differing signatures
  (or the same signature misses), the cache key is unstable — fix
  `compute_compile_time_signature` to render the self-referential `TypeValue`
  canonically/structurally (id-independent), mirroring how TS keys it. Verify: the
  miss log stops repeating + `check main.yo` completes. Secondary: confirm via a
  depth-counter panic in create_specialized whether depth is bounded (frame-size) or
  unbounded (cache) — a panic at N=2000 with a clean trace settles it.

  REFINEMENT (inspected the key): `compute_compile_time_signature` keys forall type
  args via `value_to_signature_string` → `type_to_string(t)`, which is DETERMINISTIC
  (name-based, depth-capped at 40). So it is NOT a simple key-instability miss; if
  anything the depth-40 cap + name-only struct/enum rendering risks false HITS
  (collisions), which would REDUCE recursion, not cause it. Sample composition:
  `_evaluate_expression` ~971 vs `create_specialized` ~28 ⇒ depth ≈ (specialization
  nesting ~28) × (per-body expression-eval nesting ~18) ≈ the observed ~514. So the
  next step is NOT a cache-key tweak by inspection — it is an INSTRUMENTED run (depth
  counter in create_specialized + cache hit/miss log) to settle bounded-but-huge
  (→ frame-size / box TypeValue) vs unbounded (→ a specific re-descent bug). That is a
  dedicated rebuild-driven investigation; do not blind-edit the cache key (the
  name-only loosening already regressed std 151→17 once — see
  memory yo-self-phase3-hashmap-new-blocker).

## UPDATE (2026-06-19, round 5) — INSTRUMENTED: specialization is bounded; the driver is unbounded EVAL recursion

Added a diagnostic probe in `create_specialized_function_inline` (reverted after): two
STATIC panics — one if the callee's `func_id` already appears on the specializing
stack (a cycle that slipped the mutual-recursion guard), one if specialization nesting
exceeds 300. Ran `check yo-self/main.yo` (4 GB): **NEITHER fired**, yet it still
crashed rc=138. So:

- **Specialization nesting is BOUNDED (< 300)** and **no cycle slips the guard** — the
  mutual-recursion forward-ref (committed b2f62e781) is working; specialization is NOT
  the depth driver. (Consistent with the sample: ~28 `create_specialized` frames vs
  ~971 `_evaluate_expression`.)
- **The driver is the EVAL recursion** (`_evaluate_expression → evaluate_function_call
→ … → _evaluate_expression`), and it is **unbounded/enormous**: a fresh `--release`
  (-O2, ~100× smaller frames) build crashes rc=138 at **16 GB** — at ~90 KB/frame that
  is >100k levels, so the ~514 a `sample` showed was a gross undercount; the recursion
  does not converge.

So the bug is an unbounded EVAL descent that does NOT go through deep specialization.
The most likely mechanism: the function-call **checking phase** (function.yo:525-547
sets `is_in_function_call_checking_phase`; calls `try_to_call_function_with_arguments`
with `skip_specialization: true`) descends into the callee to resolve its return type,
and for the compiler's MUTUALLY-RECURSIVE call graph (evaluate*expression ↔
evaluate_function_call ↔ …) this re-enters without a guard. TS passes
`skipCtfeExecution: true` in the checking phase precisely to stop that descent;
\*\*yo-self DISCARDS it (helper.yo:1816 `* := skip_ctfe_execution;`)\*\*. So the eval, not
specialization, recurses the cyclic graph forever.

Precise locus (read function.yo:520-547): the recursion is the OVERLOAD-RESOLUTION
trial machinery. `evaluate_other_function_call` sets
`ctx.is_in_function_call_checking_phase = true` and, for EACH candidate, runs
`_trial_call_overload_candidate(cv, ct, call_expr, func_expr, args, env, ctx, …)`. That
trial re-evaluates the call (cloned arg exprs etc.). The in-code comment already notes
this was once "exponential in nested operator-call chains (std/glob.yo never
finished)", fixed by setting the checking-phase flag so nested comptime/macro calls
short-circuit to UnknownVal. The stage-2 self-source evidently hits a case the flag
does NOT cover: the trial re-evaluates argument calls, which re-enter
`evaluate_function_call` → trials → … unboundedly for the mutually-recursive call
graph (and `skip_ctfe_execution` is discarded at helper.yo:1816, so nothing stops the
callee descent).

NEXT (clear, scoped): (1) confirm with an UNWIND-AWARE depth probe in
`evaluate_function_call`/`_evaluate_expression` (save/restore the counter across normal
return AND the trial-eval unwind handler, \_expr.yo:898) that panics at N with the
callee chain. (2) Fix in the overload-trial path: a "currently-checking (funcId,arg-
shape)" memo so a candidate trial is not re-run inside its own nested trials, AND/OR
honor `skip_ctfe_execution` to stop the callee body descent — mirror TS
function.ts:822-831 (`isInFunctionCallCheckingPhase` + `skipCtfeExecution` on each
dry-run). Validate: corpus 76/76 (must not break overload resolution — the glob.yo
case) AND `check main.yo` completes.

## UPDATE (2026-06-19, round 6) — DEFINITIVE: bounded-but-deep CTFE × giant frames (NOT unbounded)

Traced the body-eval to the CTFE gate (function.yo:2324): type-hierarchy-return /
comptime-only-return / all-args-are-types / macro functions EXECUTE their body at call
time; runtime-return functions correctly yield `UnknownVal` without it (the 2466
comment, faithful to helper.ts:1731). So the deep recursion is CTFE of the self-
source's mutually-recursive TYPE-returning functions over the self-referential
`TypeValue`.

**KEY PROOF it is BOUNDED, not unbounded:** the TS compiler SUCCESSFULLY compiles
`yo-self/main.yo` — that is exactly how `/tmp/yo-self-bin` is built (eval + CTFE +
codegen, ~5 min, exit 0). So the very CTFE recursion that overflows yo-self-bin
TERMINATES under TS. The recursion is bounded; the earlier "unbounded" reading
(round 5) was wrong.

**Therefore the crash is FRAME SIZE, not recursion count.** TS runs on a huge JS call
stack with tiny frames; yo-self-bin's enormous `evaluate_*` functions
(`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB at -O0; still multi-MB at -O2
because they are giant inlined matches holding `TypeValue`/`EvalValue` BY VALUE) blow
the C stack at a depth TS's stack absorbs. That is why `--release` (smaller, but still
multi-MB frames) also overflows 16 GB: a few-thousand-deep CTFE × multi-MB/frame > 16 GB.

**THE FIX (frame-size reduction, faithful):** box the large by-value locals in the
hottest recursive evaluator functions so each C frame shrinks ~Nx:
`_evaluate_expression`, `evaluate_function_call`, `evaluate_match`,
`evaluate_begin_expression`, `evaluate_cond` — pass/return `TypeValue`/`EvalValue` via
`Box`/`*(…)` in the hot paths and split the giant match arms into helpers (each helper
frame is independent, so LLVM stack-colors them separately). This is pervasive but
targeted at ~5 functions; it does not change semantics (so corpus stays 76/76) and
mirrors why TS never hits this (JS boxes everything). Secondary: the
def-time-body-env share (round 3) trims the heap half. Validate: corpus 76/76 + check
main.yo completes at a sane stack (e.g. 2-4 GB). NOTE the evaluator deadline (TS
\_expr.ts:236) is a TIME limit, not a depth limit — it does not prevent the overflow
because the stack blows before the deadline fires.

## UPDATE (2026-06-19, round 7) — CTFE-execution gate ELIMINATED; recursion is in arg/expr eval

Added a CTFE-execution depth cap (reverted): a `g_ctfe_exec_depth` save/restore around
the comptime/type-return execution gate (function.yo:2336), yielding `UnknownVal` past
a cap of 150. `check main.yo` (4 GB) STILL crashed rc=138, 0 output — UNCHANGED. So the
deep recursion does NOT flow through the call-time CTFE-execution gate.

Also established by reading the control flow: the non-comptime body-eval at
function.yo:~2716 is effectively UNREACHABLE — the comptime gate (2336:
`type||comptime||all_args_types||macro`) always `return(expr)`s, and the runtime path
(2507: `!type && !comptime`) always `return(expr)`s at 2714; their negations can't both
hold. So neither body-eval path (comptime nor the 2716 inline) is the recursion.

**Eliminated so far:** specialization nesting (round 5 probe, bounded <300), the
comptime/type CTFE-execution gate (round 7 cap, no effect), and both call-time
body-eval blocks (unreachable/guarded). **Remaining locus:** the recursion
(`_evaluate_expression → evaluate_function_call → _evaluate_expression`, with
evaluate_match / evaluate_cond / evaluate_begin in the sample) must be ARGUMENT
evaluation (`evaluate_expression_raw` on arg exprs, function.yo:~811/1900/2406), the
CALLEE-expression eval (~1049), or a `_evaluate_expression` construct that recurses —
descending the call graph some other way. Note the round-6 frame-size conclusion still
holds (TS compiles main.yo, so the recursion is bounded; yo-self overflows on giant
frames) — these rounds just keep narrowing WHICH eval recursion is the deep one.

NEXT (now unavoidable): a FLUSHED, UNWIND-AWARE depth probe. (1) Make output flush
(the crash yields 0 buffered output, hiding the phase — wrap with explicit flush or
write progress to a file line-by-line). (2) Increment a global at `evaluate_function_call`
entry, save/restore across the per-call exn handler (\_expr.yo:898 restores before
`unwind`), panic at N printing the callee chain. That pins the exact recursive
construct, after which the fix is either a re-entrancy guard there OR the round-6
frame-size reduction (box TypeValue) on the specific hot functions involved.

## UPDATE (2026-06-19, round 8) — CONFIRMED recursive cycle from the sample tree

Traced the deepest chain in the existing `sample` output frame-by-frame. The recursive
cycle is:

```
evaluate_function_call
  → (CTFE body execution) evaluate_begin_expression
     → evaluate_cond / evaluate_match / evaluate_initialization_assignment
        → evaluate_expression_raw → _evaluate_expression_raw_wrapper → _evaluate_expression
           → evaluate_function_call   (repeat)
```

i.e. CTFE-executing a callee body (`evaluate_begin_expression`) whose statements
(cond/match/init-assignment) contain more calls, each descending the self-source's
mutually-recursive type/comptime call graph. The ONLY `evaluate_begin_expression` call
in `evaluate_function_call` reachable here is via the comptime/type CTFE-execution
path, so the recursion does flow through it.

Re-evaluating round 7: the CTFE-cap experiment was INCONCLUSIVE, not a disproof — each
CTFE level is ~15-20 stack frames (begin+cond+match+init+identifier+call), so only
~40 CTFE levels fit a 4 GB stack, and the cap was set at 150 (never reached before
overflow). A cap low enough to fire (≈25-30) would, however, also be below plausible
legit CTFE depth, so it is a stack-vs-correctness band-aid, not the fix.

**This fully confirms the round-6 root cause:** bounded CTFE recursion (TS compiles
main.yo, so it terminates) overflowing yo-self-bin's stack because the per-level frames
are enormous (`evaluate_function_call` ~8 MB, `evaluate_match` ~9 MB at -O0; multi-MB at
-O2). **The faithful fix is frame-size reduction** in exactly these hot functions —
`evaluate_function_call`, `_evaluate_expression`, `evaluate_match`,
`evaluate_begin_expression`, `evaluate_cond`, `evaluate_initialization_assignment`:
box the large by-value `TypeValue`/`EvalValue` locals and extract the big NON-recursive
match arms into helpers so -O0 stops allocating their slots in the recursive frame.
Equivalent alternative: a yo-self CODEGEN change to reuse/colour stack slots across
match arms (so even -O0 frames shrink), which would fix this class globally. Both are
large, semantics-preserving changes touching the hottest evaluator code; corpus must
stay 76/76 at each step. No further diagnosis is needed — this is the implementation.

## UPDATE (2026-06-19, round 9) — gate-narrowing ruled out; frame-size is the ONLY fix

Considered narrowing yo-self's CTFE-execution gate (function.yo:2324,
`is_type_hierarchy_type || callee_result_is_comptime || all_args_are_types || macro`)
to match TS, which executes the body only for `isCompileTimeOnly` (helper.ts:1751) +
macro. Ruled out:

- `callee_result_is_comptime` IS `result_is_comptime_only` = TS's `isCompileTimeOnly`
  (faithful, 1:1).
- `all_args_are_types` (type-constructor instantiation, `HashMap(String,X)`) is already
  recursion-guarded (finite SomeT-leaf placeholder, per the in-code comment), so it is
  not the unbounded path.
- The self-source's deeply-recursing functions are LEGITIMATE type-computing functions
  (return Type / comptime) — TS CTFE-executes the same ones and terminates. So they
  fire via `callee_result_is_comptime` regardless; removing `is_type_hierarchy_type`
  either does nothing (flag still fires) or, if the flag has a gap, routes them to the
  UnknownVal path and BREAKS type resolution. Not a divergence, not a fix.

**Every surgical alternative is now eliminated** (specialization depth, spec cache,
CTFE-execution gate value, missing memo [TS has none], gate-narrowing). The CTFE of the
self-source's type functions is correct and matches TS; it simply recurses deep enough
that yo-self-bin's multi-MB per-level frames overflow the stack where TS's tiny JS
frames don't. **The only remaining fix is frame-size reduction** — and it must be done,
not designed-around:
(1) split `evaluate_function_call`'s giant FuncVal arm sub-blocks (the comptime-exec
2324 block, the runtime/spec 2480 block, the inline body-eval) into separate
functions so -O0 stops co-allocating every arm's temporaries in the recursive
frame; likewise `evaluate_match` / `_evaluate_expression` arms; OR
(2) a yo-self CODEGEN change so emitted C reuses stack slots across mutually-exclusive
match arms (fixes the whole class at once).
Both are large, semantics-preserving, and must hold corpus 76/76 at every increment —
a dedicated effort with its own build/validate budget. No diagnosis remains.

## UPDATE (2026-06-19, round 10) — MEASURED frame sizes + the two concrete fix options

Compiled the generated C (`/tmp/yo-self-bin4.c`) with `clang -O0 -c
-Wframe-larger-than=500000` to get REAL frame sizes. The recursive-path offenders:

| function                             | -O0 frame   |
| ------------------------------------ | ----------- |
| `evaluate_function_call`             | **13.1 MB** |
| `evaluate_match`                     | **10.4 MB** |
| `evaluate_property_access`           | 8.1 MB      |
| `evaluate_cond`                      | 2.9 MB      |
| `evaluate_initialization_assignment` | 2.3 MB      |
| `evaluate_begin_expression`          | 1.8 MB      |

The recursive cycle (`evaluate_function_call → evaluate_match/cond → evaluate_begin →
…`) sums to ~28 MB/level, so ~150 levels overflow 4 GB — matching the observed crash.

Confirmed temps ARE already block-scoped: begin blocks emit `{ … }` (begin.yo:136/200),
cond emits branch braces (cond.yo:368+), and match arms wrap each case body in `{ … }`
(match.yo:352-358). So the giant frames are NOT from missing scoping — they are
`sizeof(EvalValue)`/`sizeof(TypeValue)` (large by-value tagged unions) × the many
distinct temp slots these huge match functions hold. `-O2` coloring cannot shrink
`sizeof`, which is why `--release` still overflows (a TS-bounded depth × multi-MB
frames).

**Two concrete fix options (pick one; both are large + semantics-preserving, corpus
must stay 76/76 at every step):**

1. **Split the giant match functions.** Extract `evaluate_function_call`'s arms/sub-
   blocks (FuncVal comptime-exec / runtime / body-eval, plus TypeVal etc.) and
   `evaluate_match`'s/`evaluate_property_access`'s arms into separate helper functions,
   so each function holds far fewer temp slots and the recursive path's per-level frame
   drops from ~13+10 MB to the small active-helper frames. Highest-impact targets first:
   `evaluate_function_call` (13 MB) and `evaluate_match` (10 MB).
2. **Shrink `sizeof(TypeValue)`/`sizeof(EvalValue)`.** If the tagged unions inline large
   variants, route more variants through `Box`/pointer so every by-value slot shrinks
   ~Nx at once — fixes the whole class globally but touches the core data model.

Diagnosis is now fully quantified; this is purely an implementation task. Diagnostic
recipe for the next session: `clang -O0 -c -Wframe-larger-than=500000 <emitted>.c -o
/dev/null 2>&1 | grep 'stack frame size'` to re-measure after each extraction.

## UPDATE (2026-06-20) — memory investigation: why yo-self needs ≫ TS, and what's fixable

User question: TS compiles `main.yo` fine (~1 GB), so yo-self shouldn't need >24 GB.
Correct — it's a memory-efficiency gap, not an inherent need. Hard data gathered:

- **This machine has 16 GB RAM.** The unified `main.yo` self-compile overflows at a
  24 GB stack request (rc=138; 31.8 GB peak footprint) — so it needs >24 GB, which
  16 GB cannot provide.
- **TS's max `evaluateExpression` recursion depth compiling `main.yo` is only ~100-200**
  (instrumented `src/evaluator/exprs/expr.ts`, reverted). yo-self overflows even 24 GB
  → at ~25-40 MB per recursion level it implies a depth of **several hundred**, i.e.
  yo-self recurses **meaningfully deeper than TS for the same compilation** (a divergence).
- **Per-frame cost is huge and `-O2` does NOT shrink it.** Measured `-O0` frames:
  `evaluate_function_call` 13.1 MB, `evaluate_match` 10.4 MB, `evaluate_property_access`
  8.1 MB. A fresh `--release` (-O2) build still overflows at 12 GB — coloring can't
  reuse these slots (function-spanning lifetimes). TS's JS frames are ~1 KB; yo-self's
  are MB-scale (monolithic match functions, `TypeValue`/`EvalValue` by value). That is
  ~10⁴× per frame.
- **Per-module self-compile WORKS** (`token.yo` → valid C after the `true`/`false` fix);
  only the full unified `main.yo` (every transitive module in one eval) is memory-blocked.

So the gap is TWO compounding divergences vs TS: (a) ~10⁴×-larger per-frame stack cost
(monolithic functions + by-value structs), and (b) deeper recursion (yo-self CTFE-eval
is several-hundred deep vs TS's ~150 for the SAME type computations).

**What was tried (this round):**

- Frame extraction (runtime branch + forall loop → helpers): `evaluate_function_call`
  13.1 → 10.8 MB. Correct + committed, but ~1 MB/extraction — too slow to close a
  multi-MB × hundreds-of-levels gap by extraction alone.
- `--release` (-O2 coloring): ~2× at best; still overflows 12 GB.
- Deferring CTFE execution during def-time body VALIDATION (gate on
  `!is_validating_function_definition`, macros exempt): **no effect** — proving the
  deep recursion is the REAL CTFE execution (`is_validating=false`), the same path TS
  takes, just ~4× deeper. Reverted.

**The actionable lever (next):** the depth divergence. yo-self's CTFE eval recurses
~hundreds deep where TS does ~150 for identical type computations. Candidate causes to
investigate: (1) yo-self lacks an eval-result/CTFE memo TS has, so shared type
sub-computations re-descend; (2) the eval-dispatch indirection (`evaluate_expression_raw
→ _evaluate_expression_raw_wrapper → _evaluate_expression`) adds frames per logical
step; (3) a type-representation difference yielding more nested calls. Pinning it needs
an unwind-aware depth probe in `evaluate_function_call` whose output survives the
overflow (cap-to-survive, since stack-overflow discards buffered output). Reducing
yo-self's CTFE depth toward TS's ~150 would shrink the stack enough to fit — the
highest-leverage fix, and it directly answers the user's "should be ≈ TS".

## UPDATE (2026-06-20, per-module path) — enum-monomorphization collision (option b blocker)

Self-compiling a single module (`token.yo`) succeeds memory-wise (rc=0) but emits
INVALID C (~6 distinct codegen bugs). The root/highest-value one: **generic enum
instantiations collapse onto one C type.** yo-self emits **6 enum structs where TS emits
16** for token.yo. Concretely: `ArrayList(Token).get` and `ArrayList(u8).get` (distinct
specializations `yo_id_3835_…struct_6668…` / `…struct_3812…`) BOTH return the same
Option C enum `__yo_enum_yo_id_3832`, whose `Some.value` field is typed `uint8_t` — so
`Option(Token)` is assigned a `Token` into a `uint8_t` slot → C type error.

Root: `type_key` (codegen/utils/index.yo:640) keys an `EnumT` by its definition `id`
(`__yo_enum_yo_id_3832`), which is SHARED across all `Option(T)` instantiations. So
`type_key(Option(Token)) == type_key(Option(u8))` → same C name + same collected type
(`.value` from whichever T was collected first, here u8). TS keeps them distinct
(structural key incl. variant field types → 16 enums). The `true`/`false` fix
(commit 1d2d5aa9) removed one of token.yo's bugs; this enum collision is the next.

FIX (focused, must keep corpus 76/76): distinguish generic enum (and likewise struct)
INSTANTIATIONS — either make `type_key` for EnumT include the variant field types
(e.g. `id + structural-suffix`, so `Option(Token)` ≠ `Option(u8)` while a non-generic
enum's suffix is constant and still shares), OR ensure instantiated enums receive a
per-instantiation id at evaluation (the corpus's generic enums evidently DO get distinct
ids — only some self-source instantiations reuse the definition id, so identify why
Option(T) here reuses 3832). RISK: `type_key` drives BOTH C-name lookup AND type
collection, so the change must be consistent across both, validated incrementally
against the corpus. This is the path to module-by-module self-host (option b), which
sidesteps the unified-load memory wall entirely.

## UPDATE (2026-06-20, per-module path PROGRESS) — enum-monomorphization FIXED

Pursuing option (b) (module-by-module self-host, memory-feasible). Progress on
token.yo's codegen bugs:

- ✅ **`true`/`false` literal mangling** — FIXED (commit 1d2d5aa9).
- ✅ **Enum-monomorphization collision** — FIXED (commit af865895f). `type_key` now
  appends EnumT variant field types, so `Option(Token)` ≠ `Option(u8)` (was: both →
  one C enum with `Some.value : uint8_t`). Corpus 76/76, the `ArrayList(Token).get`
  type error is gone. yo-self enum C names now carry instantiation suffixes
  (`__yo_enum_yo_id_3891_usize`).

Remaining token.yo codegen bugs (next, each surfaces in the emitted C):

1. **enum-value `==` variant → "Failed to transpile"** (the structural-error cascade
   root). `start_kind == TokenKind.LCurlyBracket` is not primitive-infix
   (`_is_primitive_infix_operator` false for enums) and
   `generate_other_function_call` returns None → emits an inline `// Failed to
transpile` comment that breaks the surrounding C expression (→ "expected ')'",
   "while loop outside of a function", "extraneous '}'" cascade). Needs enum equality
   codegen (tag compare for fieldless enums; the corpus's working enum `==` paths
   suggest a specific gap when the RHS is a bare variant literal). generation.yo:474.
2. **`stat` / `start` collisions** — a variable named `start` and a libc symbol
   collision (`int (*)(const char *, struct stat *)`), and `redefinition of 'i'` —
   identifier-collision / shadowing codegen issues.
3. Undeclared temps (`_file____User_temp_700x`) — cascade artifacts of (1).

Fixing (1) should clear most of the structural cascade. These are the standard
"Phase-6 wave" codegen gaps, now being cleared one validated fix at a time.

## Why this matters

This is the gate for the whole Phase-6 fixpoint (stage-2 → stage-3 ≡ stage-2) and
Phase 7 (revive yo-self/tests under the stage-2 binary). Per the plan, the stage-2
compile is EXPECTED to surface a wave of executing-mode gaps; this startup crash is
the first one and must be cleared before the wave is even visible.
