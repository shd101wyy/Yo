# yo-self P1 — executing-mode transpile-error tail (candidates)

## 2026-06-22 (cont.) — str-vs-String root traced to the END (8 diagnostic cycles)

The `a.starts_with("-")` str-vs-String gap is a DEEP multi-part chain, pinned by
panic-instrumentation (results, each from a clean -O0 build):
1. `get_receiver_methods_by_name` returns **hits=1** for `starts_with` — only the
   inherent `prefix:String`; the `StrPattern` `prefix:str` overload is NOT collected.
2. Registry diagnostic (`g_dbg_sw_ids` count in `register_type_trait_method`):
   **1 individual registration** — only the inherent. The StrPattern `starts_with`
   is never registered as an individual method (lives only in the trait-VALUE via
   `register_type_trait_value`, which stores a TraitT with field TYPES but NO
   FuncVals — definitions.yo TraitT has no field-values slot).
3. impl-processing diagnostics (panics in impl.yo's method-exprs loop): the
   StrPattern `starts_with` DOES reach the loop (panic at impl.yo:~1995 fired), but
   a panic placed just before the body eval (impl.yo:~2019) did NOT fire — so the
   **throw is in the expected-type computation (impl.yo ~2000-2018)**:
   `_trait_field_type_by_label(current_trait_ty,"starts_with")` →
   `_substitute_self_in_method_ty(t, receiver_ty)` → `substitute(...)`. That throw
   propagates, ABORTS the `impl(String, StrPattern(...))` statement's def-time eval,
   and is swallowed at std/string's module-level — so NONE of StrPattern's methods
   register individually.
4. Separately: the inherent `prefix:String` overload LENIENTLY accepts the str arg
   (eval had 0 markers — `synthesize`/`are_types_compatible(String, str)` doesn't
   throw here), and `_select_matching_overload` picks the FIRST match (hits[0] =
   inherent). So even after fixing #1-3 (registering StrPattern → hits=2), the
   inherent (hits[0]) would still be picked unless selection PREFERS the exact match.

THE FIX is multi-part + regression-prone: (a) make the StrPattern impl-method
registration robust to the expected-type-computation throw (catch+fallback to no
expected type so the method still registers WITH its FuncVal) OR fix the underlying
`substitute`/`_substitute_self_in_method_ty` throw; AND (b) make
`_select_matching_overload` prefer the exact-type overload (StrPattern `str` over the
inherent `String` for a str arg). Validate vs expr/target/`check ./std`+corpus.
Diagnostic technique that worked: panic (not throw — survives the def-time swallow)
with STATIC messages, or `.contains` on a captured `err.to_string()` (works in the
TS-built binary); the def-time swallow + module-level swallow eat thrown diagnostics.

## 2026-06-22 — GENUINE TAIL MEASURED + `starts_with` overload-resolution FIXED

Rebuilt stage-1 from HEAD at `--optimize 1` and ran the REAL full self-compile
(`yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler`, peak **4.58 GB**,
matches the P2 commit series). The genuine tail is **30 markers, ALL in ONE
function**: `run_compile` (`yo-self/main.yo:877`, the `compile` CLI driver). The
function header + initial `:=` bindings transpile; the break starts exactly at the
arg-parsing `while` loop (every subsequent statement loses ExprInfo because the
def-time body eval threw and unwound there). So **30 markers = 1 failing function**,
not 30 bugs. (TS reference: 0 real markers — its 2 "Failed to transpile" / 1 "dyn()
requires object type" hits are yo-self's OWN source string literals, filter with
`grep -v 'const uint8_t' | grep -v '\.ptr'`.)

The `while` throws at **`a.starts_with("-")`**. Root (DBG'd via the swallow):
**"Cannot unify incompatible types: String and str"**. `starts_with` is OVERLOADED —
inherent `impl(String)` `starts_with(prefix : Self=String)` (string.yo:842) + the
`StrPattern` trait `starts_with(prefix : str)` (string.yo:1560). A comptime_string
LITERAL coerces to `str`, which only the `str` overload accepts; but yo-self's
`_try_find_receiver_method` (function.yo:234) took `hits.get(0)` (the inherent
`String` one) and the call-site unify THREW instead of falling over to the `str`
overload. (`s.starts_with(p)` with a String VARIABLE worked because hits[0] matched.)

**FIX (committed-ready, corpus 83/83, repro 0 markers, TS check OK):** mirror TS
overload resolution (function.ts:330 keeps ALL candidates as `functions`; :1691
filters to type-matching). Added `all_hits : ArrayList(MethodEntry)` to
`ReceiverMethodResult`; the call-site (`.None` arm at function.yo:~3101) now calls a
new `_select_matching_overload` that trial-calls each candidate (via the existing
`_trial_call_overload_candidate` — swallowing, fresh-id-cloned, side-effect-free) and
picks the FIRST that type-checks, falling back to hits[0]. Single-hit (the common
case) skips trials → no behavior change. New helper `_build_receiver_call_args`
builds the trial arg list (receiver prepend + `&(...)` ptr-conv).

### `run_compile` codegen gaps (the eval now succeeds):

1. **Default-arg codegen (omitted optionals not emitted) — ✅ FIXED (commit
   98b95a9dd), method-call path.** `a.starts_with("-")` omits `(position : usize)
   ?= 0`; the eval bound the default VALUE but never pushed it to
   `runtime_arg_exprs_in_order` → C `too few arguments`. Fix (faithful, mirrors
   helper.ts:328-344): added `FuncParam.default_value_expr` + a func-id side-table
   (`g_func_param_default_exprs`), and in `try_to_call`'s Step 7 omitted branch
   clone+evaluate+push the default expr to `rt_args`. Corpus 83/83. **Remaining:
   the inline-FuncVal arm (function.yo ~2424) for DIRECT calls** (`add(i32(3))`
   still C-fails "too few arguments") — same pattern, push the default expr after
   the supplied-args loop; the side-table is already there.
2. **str-vs-String = trait-impl overload NOT COLLECTED (diagnostic-confirmed root).**
   After fix #1, `a.starts_with("-")` emits all 3 args but C-fails `passing
   '__yo_str' to parameter of incompatible type '…' (String)`: codegen emits the
   INHERENT `starts_with(self : String, prefix : String, position)` (`yo_id_4572` —
   body matches `prefix._bytes`) with the str literal. DIAGNOSTIC (panic-instrumented
   `_try_find_receiver_method`): for `a.starts_with`, **`get_receiver_methods_by_name`
   returns hits=1 — only the inherent**; the `StrPattern` trait `starts_with(prefix
   : str)` (std/string.yo:1567 `impl(String, StrPattern(...))`) is NOT collected. So
   `_select_matching_overload` (fix b4788d38e) is a no-op here (1 hit) and the
   inherent is used; the comptime_string `"-"` then matches the inherent's `String`
   prefix LENIENTLY (no "Cannot unify" throw — confirmed: `prefix`'s resolved_pt is
   CONCRETE, not a SomeT, and 0 eval markers), so the eval records the inherent and
   codegen emits the String-param fn with a str arg. ROOT: `impl(Type, Trait(...))`
   registers its methods as a trait-VALUE (via `register_trait_value_fn`), NOT as
   individual `register_type_trait_method(Type_id, …)` entries (only the
   method-exprs loop at impl.yo:1982/2108 does that, for direct `label : fn` fields).
   `get_receiver_methods_by_name_from_env` (env.yo:2378) only does the registry
   lookup, NOT the TS `.trait.fields` walk over the type's impl'd-trait values (the
   comment at env.yo:2434 acknowledges this divergence). FIX (faithful, mirrors TS
   getReceiverMethodsByNameFromEnv): make `get_receiver_methods_by_name_from_env`
   ALSO collect methods from the receiver type's impl'd-trait values, OR register
   trait-impl methods individually under the receiver id at impl time. THEN
   `_select_matching_overload` must PREFER the exact match (`StrPattern` `str` over
   the inherent `String`, since the inherent leniently matches str too — likely an
   are_types_compatible(String, str) leniency to also tighten). Regression-prone
   (adding candidates changes dispatch); validate vs expr/target/`check ./std` +
   corpus. NOTE: my earlier "Self floats as SomeT" hypothesis was DISPROVEN by the
   diagnostic — `prefix` is concrete; the issue is collection, not Self-resolution.
   Surfaced only by the fixpoint (corpus has no str-literal overloaded-method call
   omitting a default).
3. **`dyn(<template string>)` codegen** — `exn.throw(dyn(\`compile: missing input
   file…\`))` (run_compile's first stmt) emits `/* Error: dyn() requires an object
   type (use box() for value types) */` (a broken `Type x = ;` decl). TS compiles it
   (its only such hit is the source string literal). The recorded arg type for the
   `dyn(\`…\`)` arg is a value-type String in yo-self vs an object/Box type in TS.
   2 instances in the self-compiled C (run_compile + one other fn).

Beyond these, the statements AFTER the `while` (std_path / io.await / compile_module /
the template `dyn()`s) were never reached by the eval (it threw at the while), so they
may surface their OWN gaps once the while compiles. The fixpoint needs ALL of
run_compile's tail drained, then `stage2.c` → stage2 binary → stage3 (≡ check).

## Status: OPEN — the P1 drain (lead, now that P0/corpus is deterministic)

Per-module `// Failed to transpile` markers, each a real executing-mode
evaluator/codegen gap. As of 2026-06-21 (after the Index-trait, cond/panic,
open-import, and P0 double-free fixes), the small/medium modules are near-clean:

Per-module status as of 2026-06-21 AFTER Candidates 1–3 + the frame-depth fix +
the specialization-Self fix + the receiver-arg-type fix:

| module | swallowed errors | note |
|---|---|---|
| `error/token/utils/lexer/expr/target/naming_checker` | **0** | ✅ all clear (Candidates 1–3 + frame-depth relaxation) |
| `value.yo` | 6→2 swallowed | `Self`-not-found ×4 (378914804) + `field_labels` (8910182ad) RESOLVED. DBG_SW2 re-survey shows 2 remain: (a) `field_types` ×1 — `types.clone()` (the SECOND arg of the SAME `.Tuple(labels, types) => TypeValue.Tuple(labels.clone(), types.clone())` at definitions.yo:392, masked behind field_labels before) where `types : ArrayList(Self)` has the RECURSIVE-ENUM element `TypeValue` (vs `labels`'s concrete `String`) → still Type(1); receiver-arg-type fix did NOT clear it = recursive-enum-element intersection (deeper). CONFIRMED ROOT (DBG_EL instrumentation): the clone receiver's element IS a recursive-enum SELF-SHELL — `types.clone()` has `types : ArrayList(<enum:..._self_shell>)` (e.g. `enum_yo_id_5981__self_shell`). The empty-variant shell as the element makes `with_capacity`'s `(*(T))(_ptr)`/`sizeof(T)` degenerate to Type(1) (shell has no layout). FOUR fix attempts, ALL ruled out (build-validated, reverted, zero regression each): (1) try_to_call self_type from self arg → REGRESSED expr/target/parser; (2) substitute `Self` SomeT in receiver type → no-op (it's a SHELL, not a SomeT); (3) `resolve_enum_shell` the receiver Struct's type_arguments in create_specialized → no-op (T bound separately, upstream); (4) `resolve_enum_shell` the `forall_val` in try_to_call's explicit-forall loop → no-op (with_capacity's T is bound via a DIFFERENT path — the receiver-type-arg→forall derivation in the DISPATCH, NOT the explicit-forall loop). FIVE fix attempts now ruled out (build-validated, reverted, zero regression each):
(1) try_to_call self_type ← self arg → REGRESSED expr/target/parser; (2) substitute
`Self` SomeT in receiver → no-op (it's a SHELL not a SomeT); (3) resolve_enum_shell
the receiver Struct type_arguments in create_specialized → no-op; (4)
resolve_enum_shell `forall_val` in try_to_call's explicit-forall loop → no-op;
(5) resolve_enum_shell `recv_type_args` at the static-dot derivation
(function.yo:2477) → no-op (`types.clone()` is an INSTANCE call, so
_static_dot_receiver_self_type returns None → recv_type_args empty). DEFINITIVE
CONCLUSION: `_funcval_bind_foralls` (function.yo:733) binds foralls by NAME-MATCH
(`ptn == fa_name`) + recv_type_args fallback — NEITHER fires for instance `clone`'s
impl forall `T` (param type is `ArrayList(T)`, not literally `T`), so the shell-`T`
comes from yet another path (captures `cap_vals`, or structural self-arg
unification). The recursive-enum SELF-SHELL propagates through MANY
specialization-input paths; whack-a-mole at each input does NOT converge (SIX
tried — the 6th: resolve_enum_shell the pointee in the `.Pointer` cast branch
(function.yo:2103) was ALSO a no-op, PROVING `*(T)` with `T=shell` does not even
reach the `.Pointer` cast — the shell breaks the `*(T)` TYPE-APPLICATION evaluation
UPSTREAM, yielding Type(1) before any cast). DEFINITIVE: stop guessing fix sites
(6 failed). KEY: `resolve_enum_shell` DOES resolve these shells correctly —
`register_enum_final(shell_id, …)` (enum.yo:706) registers the final under the
SHELL id (`${enum_id}__self_shell`), which is exactly what resolve_enum_shell looks
up, so the 4 resolve_enum_shell attempts (#3–#6) being no-ops means the
field_types-failing `types.clone()`'s `T` is NOT at any path I resolved. The "shell
in clone→with_capacity" mechanism was ASSUMED from DBG_EL (which showed shells in
SOME clone receivers) but NEVER CONFIRMED for the actual failing `types.clone()`
call — its `T` may come from a different path, or types.clone() may fail for a
DIFFERENT reason entirely. INSTRUMENTED (DBG_CONSTR at the construction check, type.yo:275): `types.clone()`
evaluates to `valkind=TypeVal` (a TYPE value, typed Type(1)) — i.e. `clone` itself
resolves to a TYPE-returning result on this receiver, NOT a runtime clone. SAME
root for parser.yo's `args`: `__v_args.clone()` also → `valkind=TypeVal`. So the
issue is in CLONE METHOD RESOLUTION on a receiver whose type carries the recursive
self-shell (the method likely isn't found on the shell-element receiver, so
`types.clone` resolves to a type and `(type)()` yields a type). 7th fix attempt
(resolve_enum_shell_deep — a NEW recursive shell-resolver — applied to the
destructured field TYPE at both match.yo destructure sites) was ALSO a no-op:
resolving the field TYPE doesn't change that `clone` resolves to a TypeVal. SEVEN
build-validated fix sites now ruled out; the resolve-shell approach CONSISTENTLY
no-ops, so the bug is NOT "shell reaches type-application" — it is in how the CLONE
METHOD CALL is resolved/evaluated when the receiver type contains the shell. The
next effort must trace the `types.clone()` method-call resolution itself (property
access → method lookup → why it yields a TypeVal instead of a runtime call) — a
deep focused effort in method dispatch + recursive-enum-shell, the hardest
subsystem. Systemic (value.yo field_types + parser.yo args), warm-up-masked.
8TH ATTEMPT (no-op, reverted): resolve_enum_shell the receiver type in
`_try_find_receiver_method` (function.yo:199, runtime method dispatch). No-op
because for `types.clone()` `receiver_info.ty` is `ArrayList(shell-element)` (a
Struct — top-level resolve_enum_shell doesn't touch the nested element), and the
inner `<enum shell>.clone()` routes through a DIFFERENT clone-resolution path
(property_access processes it per DBG_PA, yet the call still yields a TypeVal).
8 distinct interception points all miss → the shell propagates through clone
resolution PERVASIVELY. The fix needs EITHER (a) systematic shell elimination at
the recursive-enum representation / `register_enum_final` time so no `__self_shell`
survives into method resolution (preferred — kills the whole class), OR (b) finer
instrumentation to pin which clone-resolution path (property_access vs
_try_find_receiver_method) evaluates the failing `types.clone` func and returns a
type. Confirmed beyond 8 single-build attempts — a focused multi-step effort.
9TH ATTEMPT (no-op, reverted): resolve_enum_shell at the CENTRAL method-registry
chokepoint `type_id_or_empty` (type_trait_methods.yo:58 — used by every
method/assoc-type lookup) — still no-op. CRITICAL PATTERN: resolve_enum_shell has
now no-op'd across FIVE distinct resolve attempts (#3,4,5,6,9). This strongly
implies resolve_enum_shell CANNOT resolve THIS shell at these points — most likely
the shell's final is NOT in `g_enum_finals` when/where these run (a
registration-TIMING issue: the value.yo def-time-eval reaches the inner element
clone before `register_enum_final` has registered EvalValue's final, OR under a
different g_enum_finals state), NOT a wrong-site issue. THE DEFINITIVE NEXT STEP is
to INSTRUMENT resolve_enum_shell itself (print whether it finds the final for the
failing shell id during value.yo compile): if it does NOT find it → fix is
registration timing/ordering (ensure the final is registered before any clone of a
shell-typed value); if it DOES find it → the failing clone routes through a path
that never calls these resolve sites (trace it). Either way this is a deep,
focused, multi-step effort in the recursive-enum-shell subsystem — NOT a single
targeted resolve insertion (9 ruled out). Warm-up-masked; systemic (field_types + args).

DEFINITIVE DIAGNOSTIC (build #21, DBG_RESOLVE inside type_id_or_empty): for the
SAME shell id (e.g. `enum_yo_id_5981__self_shell`), resolve_enum_shell returns BOTH
`…5981__self_shell|vars=0` (final NOT registered — TIMING) on ~2 calls AND
`…5981|vars=39` (resolved) on ~9 calls. So TWO facts are now PROVEN:
  (1) TIMING — some clone-resolutions run BEFORE `register_enum_final`, so resolve
      is a genuine no-op there (vars=0).
  (2) PATH — the chokepoint fix used the RESOLVED id (vars=39) yet field_types
      STILL failed → `clone` for these enums is NOT in the `type_id_or_empty`
      method registry at all; it is resolved via a DIFFERENT path (the generic
      Clone-impl resolver / derived-clone), which the shell breaks.
So the failing `types.clone()`/`__v_args.clone()` resolve via the generic-impl /
derived-clone path on a shell-typed RUNTIME (NoVal) receiver — NOT
`_try_find_receiver_method` (8th attempt, no-op) and NOT
`find_methods_from_generic_impls` (takes a TypeVal, our receiver is NoVal). The
TRUE next step: find the clone-resolution path for a RUNTIME enum value receiver
(derive(Clone)/generic Clone impl dispatch in the method-CALL path,
evaluator/calls/*), resolve the shell receiver THERE, AND fix the registration
TIMING so the final exists before any clone of a shell-typed value. A deep,
multi-faceted effort (shell + clone-via-generic-impl/derived + registration timing)
— the hardest subsystem, confirmed beyond 9 build-validated targeted attempts. That is a focused
effort on the recursive-enum-shell subsystem (the hardest part of the port, per
[[yo-self-recursive-enum-self-shell]] + [[yo-self-phase3-hashmap-new-blocker]]).
Warm-up-masked (not a real fixpoint blocker). (b) `and` ×1 — `name.starts_with("Box(")` at guards.yo:561 → non-bool. ISOLATED (repro ladder, this session): NOT default-arg (both `starts_with("a")` and `starts_with("a", usize(0))` fail) and NOT the `&&` (starts_with ALONE fails; `len()==` alone works). ROOT: a COMPTIME_STRING LITERAL arg to a `Self`-TYPED param — `name.starts_with(p)` with a String VARIABLE `p` WORKS, but `name.starts_with("a")` (literal) FAILS. `starts_with(self : Self, prefix : Self, …)`: the comptime-arg→param coercion (helper.yo:482) is GUARDED `!is_some_type(resolved_pt)`, and `prefix`'s `Self` is NOT resolved to the concrete receiver (String) because `ctx.self_type` is not the receiver during `try_to_call`'s arg-binding (the create_specialized Self fix runs LATER). FIX ATTEMPT (FAILED + REVERTED, this session): setting `ctx.self_type` from the `self` param's arg_type inside `try_to_call`'s param loop (so a later `prefix : Self` resolves) did NOT fix starts_with AND regressed expr 0→1, target 0→1, parser 4→5. Two reasons learned: (1) `resolved_pt` for `prefix` is an ALREADY-EVALUATED SomeT, not the `Self` identifier, so setting `ctx.self_type` does NOT make `evaluate_function_parameter_type_again` resolve it; (2) the self param's `arg_type` is NOT a clean receiver type (e.g. `*(Self)` for `ref(self) : Self` methods), so overwriting `ctx.self_type` with it corrupts Self resolution elsewhere. So the real fix must RESOLVE the SomeT `Self` in `resolved_pt` directly (in the coercion at helper.yo:482, guarded: only when the SomeT is `Self` and resolves to a concrete non-SomeT) — the regression-prone coercion area (touching it unguarded once regressed std 151→17, see [[yo-self-template-string-to-string-cluster]]); a careful, validated focused effort. Gates that catch regressions here: the small-module marker counts (expr/target were 0) + `check ./std` (sensitive to this coercion class). 2ND `and` ATTEMPT (no-op, reverted): resolve a BOUND SomeT via `get_value_of_some_type_from_env(callee_env_r, resolved_pt)` before the coercion guard — no-op because `Self` is NOT bound in callee_env_r during starts_with's arg-binding (the receiver type isn't threaded there). UNIFIED ROOT (both value.yo residuals): `field_types` AND `and` both stem from the RECEIVER TYPE not reaching instance-method arg-binding / method-resolution. Threading it is the central method-dispatch change that (a) regressed expr/target/parser when done via ctx.self_type from the self arg (ref-self `*(Self)` corruption) and (b) no-op'd via env-resolution (Self not in env). So the value.yo tail needs ONE careful central fix: correctly thread the (deref'd, non-pointer) receiver type into instance-method arg-binding + method-resolution + as `Self` for coercion — validated incrementally against expr/target/std (all sensitive). A focused effort; 12 build-validated targeted attempts (10 field_types + 2 and) ruled out the peripheral approaches. 3RD `and` ATTEMPT (no-op, reverted): resolve a bare `SomeT("Self")` resolved_pt via the bound `self` var in callee_env_r before the coercion — no-op, so `prefix`'s resolved_pt is NOT a bare SomeT literally named "Self" (likely a fresh-id SomeT whose name isn't "Self", OR `self` isn't bound at that point, OR the failing path isn't this check_if_function_parameter_matches_argument). DEFINITIVE NEXT STEP for `and`: instrument `resolved_pt` (type_to_string + the SomeT name/id) for the prefix param of starts_with when compiling value.yo — determine the ACTUAL type before designing the resolution. INSTRUMENTATION OBSTACLE (build #24): `helper.yo` CANNOT `import("std/fmt")` for `eprintln` — it creates a circular import (helper.yo → std/fmt → … → calls/function.yo → helper.yo), build fails rc=1. So instrument via a NON-eprintln mechanism: a module-level `(g_dbg : ArrayList(String))` global written in helper.yo and printed by a caller that CAN import std/fmt, OR add the diagnostic in a callee/caller of check_if_function_parameter_matches_argument that already imports fmt, OR temporarily print from `function_type.yo` (which can import fmt) by threading the value out. 13 build-validated attempts total (10 field_types + 3 and); all peripheral guesses ruled out — both value.yo residuals need finer instrumentation of the exact type/path THEN a regression-prone central fix (a focused multi-session effort, not single-build attempts). The 6 visible MARKERS are all `if(...)`-as-value COLLATERAL = separate OPEN issue `yo-codegen-block-rhs-drops-statements`. |
| `parser.yo` | 4 markers | `array_list(...)` macro-expansion ×3 (gated MACRO_DISPATCH) + arg-count |

IMPORTANT — STACK, not memory: standalone-compiling a big module SIGSEGVs (rc=139,
peak mem only ~2.8 GB — NOT OOM) at the default 1 GiB main-thread stack due to
deep compile-time recursion. Run with `YO_MAIN_STACK_MB=4096` (as
scripts/diff-test.sh already does) and it compiles. So `value.yo`'s earlier
"no .c" was stack exhaustion, not a transpile bug; with 4096 MB it emits C with 6
errors.

The visible `// Failed to transpile` markers (all `if(...)`-shaped) are COLLATERAL
— a minimal `if(b, …)` compiles fine. Instrumenting the def-time swallow
(`_trial_eval_fn_body`) under the big stack surfaced the REAL per-function throws
(the remaining MEASURABLE P1 tail, 2026-06-21):

| module | real swallowed errors (count) |
|---|---|
| `value.yo` | `Variable "Self" not found` ×4 (dominant); `Type mismatch for type member "field_labels"` ×1; `Expected bool type for "and" argument` ×1 |
| `parser.yo` | `Type mismatch for type member "args"` ×2; `Argument count mismatch: expected 0, got 1` ×1 |

These are NEW families (distinct from Candidates 1–3): (a) `Self` unbound in some
def-time body-eval context (likely an impl/trait-method body or a nested
closure/construction referencing `Self`); (b) struct/enum CONSTRUCTION type-member
mismatch (`field_labels`/`args` — a `Struct(...)`/`EnumT(...)` built with a
wrong-typed field at def-time eval); (c) `and`/arg-count argument-shape errors.
The `Self`-unbound family (4×, dominant) is the highest-leverage next target —
fixing it should also clear the collateral `if`-markers in those functions.
ROOT (traced, no rebuild): the identifier evaluator DOES resolve `Self` via
`ctx.self_type` (identifer_and_operator.yo:107, `if identifier=="Self" &&
self_type.is_some()`); so a `Self not found` means `ctx.self_type` is **None**
during the DEF-TIME body eval of some type/impl method that references `Self`
(as a param type or constructor). `create_function_body_evaluation_context`
(function_type.yo) only COPIES the parent ctx's `self_type`, so the parent ctx
at that def-time-eval site lacks it. Most type methods work (self_type is set),
so the 4 failures are specific — likely derived methods, or methods
def-time-evaluated outside their impl's self_type scope. NEXT: instrument the
identifer_and_operator.yo:166 throw to print `token.module_path:token.row` (so
the swallow names the failing method) → set `ctx.self_type` for that def-time
path. EvalValue is itself a recursive enum (`ArrayList(Self)`/`Box(Self)`
fields), so its derived/`==` methods are prime suspects.

The other big modules (`function.yo`, `helper.yo`, `codegen_c.yo` TIMEOUT >240 s;
`match.yo` SIGABRTs) are slow/heavy standalone even with the big stack — their
tail + the unified self-host fixpoint remain gated on P2 (memory / compile-time)
or a 32 GB+ box.

## `Self`-not-found in specialized method bodies — ✅ RESOLVED

The dominant `value.yo` family (`Variable "Self" not found.` ×4) was traced via
the printing-swallow instrumentation (DBG_SW handler in `_trial_eval_fn_body` +
DBG_LOC at the def-time call site) to four GENERIC method bodies evaluated during
SPECIALIZATION:
- `std/collections/hash_map.yo:287` (`set` → `Self._find_bucket(self, key, hash)`)
- `std/collections/hash_map.yo:335` (`get` → `Self._find_bucket(...)`)
- `std/collections/hash_set.yo:272` (`add` → `Self._find_slot(self, element, hash)`)
- `std/collections/hash_set.yo:306` (`remove`/`contains` → `Self._find_slot(...)`)

These surface when compiling `value.yo` because an outer function's def-time body
eval calls `map.set(...)`/`set.add(...)` with concrete K/V, triggering
specialization of the generic method. The specialized body is evaluated by
`create_specialized_function_inline` (`evaluator/calls/helper.yo:1338`,
`evaluate_begin_expression(cloned_body, callee_env, ctx, …)`), which did NOT set
`ctx.self_type` — so `Self` (and `Self.static_method`) hit
`identifer_and_operator.yo:166` "Variable Self not found." and the def-time
swallow ate it → no ExprInfo → "Failed to transpile".

ROOT vs TS: TS evaluates the specialized body with `{ ...context }`
(`helper.ts:2434`), and the method-dispatch caller has already set
`context.SelfType` (carried from the method's `functionType.SelfType`, a field on
TS `FunctionType`). yo-self's `Func` TypeValue has NO `SelfType` field and the
dispatch doesn't thread `self_type` to this point, so the specialized body lost
it. FIX (faithful-in-effect, commit 378914804): reconstruct `ctx.self_type` from
the bound `self` parameter's type (the concrete receiver) just before the
specialized body eval, scoped (saved + restored in the context-restore block, so
nested specializations each see their own receiver). NOT a `self`-named-param
heuristic at `create_function_body_evaluation_context` — that path (the def-time
eval) is NOT where generic methods are evaluated; specialization is. Validated:
value.yo Self-not-found 4→0 (all-DBG_SW 6→2), parser/expr/target/naming_checker
unchanged, check ./std 152/152.

A fully-faithful alternative (add a `self_type` field to the `Func` enum, stamp
it from `ctx.self_type` at `evaluate_function_type`, read at every body-eval
site) would also cover STATIC methods (no `self` param) that reference `Self` —
none are among the current tail, so deferred. Tracked here if such a case
surfaces.

## Remaining value.yo (2) + parser.yo (3) — characterized, ORDER/CONTEXT-dependent

After the Self fix, the remaining swallowed errors are:
- `value.yo`: `Type mismatch for type member "field_labels"` ×1 (definitions.yo:392,
  `.Tuple(labels, types) => TypeValue.Tuple(labels.clone(), types.clone())` —
  `labels.clone()` evaluated to `Type(1)`); `Expected bool type for "and"` ×1
  (guards.yo:561, `… && name.starts_with("Box(")` — the method call evaluated to
  non-bool).
- `parser.yo`: `Type mismatch for type member "args"` ×2 (parser.yo:996,1410,
  `array_list(arg, arg_copy)` / `array_list(str_atom)` → `Type(1)`);
  `Argument count mismatch: expected 0, got 1` ×1 (parser.yo:1219,
  `array_list(rhs_expr)`).

TWO root families:

1. **`array_list(...)` (parser ×3) = MACRO EXPANSION at def-time eval.**
   `array_list` is a MACRO (`std/collections/array_list.yo:827`,
   `fn(...(quote(elems))) -> unquote(Expr)`). At def-time body eval the call is
   NOT expanded → evaluated as a plain variadic fn → `Type(1)` (from
   `unquote(Expr)`) or "expected 0, got 1" (the `...(quote(elems))` declares 0
   normal params). Tied to the gated MACRO_DISPATCH subsystem (corruption history,
   see [[yo-self-macro-dispatch-corruption-fixed]] / [[yo-self-macro-expansion-port]]).
   Deferred — deep + gated.

2. **`labels.clone()` (value `field_labels` ×1) = pointer cast `(*(T))(_ptr)`
   yields `Type(1)` during NESTED `clone` specialization. ✅ RESOLVED (commit
   8910182ad).** FIX: in `create_specialized_function_inline` set `ctx.self_type`
   from the actual RECEIVER ARGUMENT's type (`arg_values.args[0].arg_type`) when the
   first param is `self`, instead of the `self` param's DECLARED type — which during
   def-time signature eval can be a freshly-minted SHELL struct id for the same
   generic (the dual-struct-instantiation root). The argument carries the real,
   complete receiver struct, so `Self`→that struct and the nested
   `Self.with_capacity`/`(*(T))(_ptr)` specialization succeeds. Validated: repro
   `xs.clone()` 1→0, value.yo field_labels cleared (remaining value.yo markers are
   if-as-value collateral, `yo-codegen-block-rhs-drops-statements`), std 152/152,
   corpus PASS 83/83. The `and`/`name.starts_with()` sibling (a self-first method)
   is likely cleared by the same fix — re-verify with DBG_SW if pursuing.
   Investigation history (kept for the methodology):
   - Reliable minimal repro: a fn `m_clone(xs : ArrayList(String)) -> xs.clone()`
     that is **CALLED from `main`** (so its body is EMITTED) fails to transpile.
     The earlier "clean in isolation" repros were a RED HERRING — with a trivial
     `main` the fn is dead code (never emitted), so no marker even though the
     def-time eval threw. Emit it (call it) and it fails. So this is NOT
     order/context-dependent; it is consistent once the body is emitted.
   - The swallowed throw (via the instrumented binary): `Type mismatch for type
     member "_ptr": Expected <enum…(Option(*(T)))> Got Type(1)` at
     `std/collections/array_list.yo:124` — `_ptr : .Some((*(T))(_ptr))` inside
     `with_capacity`. `xs.clone()` calls `Self.with_capacity(...)`; when
     `with_capacity` is specialized INSIDE clone's specialization (nested), the
     pointer cast `(*(T))(_ptr)` evaluates to `Type(1)` instead of a `*(T)` value.
   - Cast dispatch: `evaluator/calls/function.yo:2103` (`.Pointer(_) =>` →
     `try_to_convert_to_pointer_type`). NEXT STEP: instrument there to print
     `func_type` (is the `.Pointer` branch even taken? is `T` bound to String, or
     is `*(T)` a `*(SomeT)`/Type?) for the `(*(T))(_ptr)` call when compiling
     repro8; the cast likely falls through to the `_ =>` numeric branch or
     `try_to_convert_to_pointer_type` returns a type because `T` is unbound in the
     nested specialization. Likely fix: bind the callee type's forall (`T`) in the
     nested `with_capacity` specialization, OR resolve `*(T)` against the bound
     element type before the cast.
   - CONFIRMED PRE-EXISTING: repro8 fails IDENTICALLY (2 markers) under the
     pre-Self-fix baseline binary — the 378914804 Self fix introduced NO
     regression here.
   - CAPSTONE (warm-up): adding a DIRECT `with_capacity` call
     (`m_wc(n) -> ArrayList(String).with_capacity(n)`) BEFORE `m_clone`, both
     CALLED from main, makes BOTH pass (0 markers). So it is a NESTED-SPECIALIZATION
     bug: when `with_capacity` is first specialized via the NESTED path (inside
     `clone`'s specialization), the impl forall `T` is NOT bound → `sizeof(T)` /
     the `(*(T))(_ptr)` cast degenerate to `Type(1)`. When `with_capacity` is first
     specialized DIRECTLY, `T` binds, it caches a GOOD entry, and the later nested
     call reuses it. IMPLICATION: this error is LARGELY MASKED in the full
     self-compile (where `with_capacity`/`clone` get warmed by direct calls
     throughout std), so it is substantially a STANDALONE-per-module-survey
     ARTIFACT — the per-module `--emit-c` survey OVERCOUNTS errors that warm-up
     hides in the real fixpoint build. Real fix (deep, deferred): bind the
     callee's impl forall (`T`) from the receiver/Self type in the NESTED
     specialization path (create_specialized_function_inline / the call dispatch),
     not only on the direct path. Lower priority than first thought (likely not a
     real fixpoint blocker).
   - DEFINITIVE ROOT (DBG_FA instrumentation printing `arg_values.forall_args`
     VALUES in create_specialized_function_inline, failing m_clone-only vs passing
     m_wc-direct-first): the forall-binding hypothesis is DISPROVEN — `with_capacity`
     specializes with `names=[T] forall_args=[String]` in BOTH cases, so `T` IS
     bound to `String`. The real differentiator is STRUCT IDENTITY:
       FAIL: with_capacity specialized for `self=struct_3934`(String) + `struct_3984`(u8); NO struct_4028.
       PASS: same + with_capacity for `self=struct_4028`(String)  ← the extra one.
     `ArrayList(String)` exists as TWO distinct struct ids (3934 vs 4028). `m_clone`'s
     `xs.clone()` (receiver = one instance) has clone's body call `Self.with_capacity`
     where `Self` resolves to the OTHER `ArrayList(String)` instance (struct_3934, a
     def-time-minted shell); that instance's `with_capacity` body throws (the
     `(*(T))(_ptr)`→Type(1) construction mismatch) so clone's body eval fails →
     `xs.clone()` gets no ExprInfo → "Failed to transpile". The passing m_wc case
     first specializes `with_capacity` for struct_4028 directly, and warm-up reuses
     it. So this is the DUAL-STRUCT-INSTANTIATION / CTFE-struct-identity class (the
     same family as the HashMap.new cache collision — see
     [[yo-self-phase3-hashmap-new-blocker]] — and the "two struct instantiations of
     one generic type" def-time-minting issues), NOT forall-binding and NOT
     cache-key-completeness alone. Real fix is deep struct-identity unification
     (make the def-time signature eval and the call-site agree on ONE struct id for
     `ArrayList(String)`, OR resolve `Self` in clone's body to clone's ACTUAL
     receiver struct, not a freshly-minted shell). Known-hardest area; high
     regression risk; a focused effort, not a session-end fix. (Diagnostic note:
     `type_to_string` renders a struct as `<struct:id>` WITHOUT type args; print
     `arg_values.forall_args` values, and compare struct IDS across pass/fail.)
   The `name.starts_with()` (`and` ×1) error is a sibling — same "method call in an
   emitted body during specialization mis-resolves" class; re-confirm its exact
   throw the same way. LOWER-VALUE than the Self family (2 errors, 1 module);
   does NOT gate the fixpoint (P2 does). Session fixme.yo repro ladder: repro2→3
   (isolate method-call) → repro5/6 (FALSE clean = dead-code-elim) → repro7 (enum
   fn alone, trivial main → false clean) → **repro8 (fns CALLED from main → both
   bodies fail; the reliable repro)**.

## Candidate 1 — derived multi-field `Clone` — ✅ RESOLVED (4-layer fix)

Root-caused as FOUR stacked yo-self-only codegen bugs (not the suspected
generate_other_function_call constructor-callee gap below). All fixed; see
`yo-self-derive-clone-typename-quote.md` for the overview, plus
`yo-self-anon-fn-ref-param-deref.md` and `yo-self-method-inline-ref-amp.md`:
(1) `Type.to_comptime_string` stored an unquoted StrLit → corrupted constructor
head (Token->oke, T->empty); (2) `ref(self)` field reads not dereferenced
(anon-fn binding dropped is_ref); (3) derived enum clone re-materialized its
`ref(self)` match subject into a colliding local `self`; (4) a primitive field's
inlined `__yo_return_self` receiver was not address-of'd. Regression tests
`derive_clone_enum_string.yo` (non-primitive) + `derive_clone_multifield.yo`
(primitive) in the corpus.

### Original (now-disproven) hypothesis + repro

```rust
open(import("std/string"));
K :: enum(A, B);
derive(K, Clone, Eq(K));
T :: struct(kind : K, value : String, row : usize, col : usize, ch : usize, mp : String, inp : String);
derive(T, Clone);
mk :: (fn() -> T)(T(kind : K.A, value : String.from("v"), row : usize(1), col : usize(2), ch : usize(3), mp : String.from("m"), inp : String.from("i")));
main :: (fn() -> unit)({ a := mk(); b := a.clone(); () });
export(main);
```

yo-self emits, in T's derived clone body:
```c
return // Failed to transpile (((self.kind).clone)(), ((self.value).clone)(), …);
```
i.e. a struct construction whose **callee renders empty** (positional
`(field.clone(), …)`, no `T` head). An EXPLICIT labeled `T(kind : …, …)` (as in
`mk`) transpiles fine — only the derive-generated positional/`Self(...)` form
fails. This is the real `expr.yo:fn_..._6604` (Token's derived clone, rendered
`oke(...)`) and affects every `derive(Clone)` multi-field struct used in return
position (Token, AST nodes, …).

Likely root: yo-self's `generate_other_function_call` value-struct-constructor
branch doesn't recognize the derive-synthesized constructor callee (an empty/
gensym atom or a `Self` form) the way it recognizes a named/labeled `T(...)`.
Compare how the evaluator annotates the derived-clone construction's ExprInfo
(`value` = StructVal shell + `runtime_arg_exprs_in_order`) vs an explicit
labeled construction, and route the synthesized form through the same
runtime-construction emitter.

## Candidate 2 — ✅ RESOLVED (evaluator side): recursive-enum self-shell in nested match

`expr.yo` `is_function_boundary_arrow` is FIXED (expr.yo transpile errors 1→0).
Root: it does `match(func_box.*, …)` two levels into `AstExpr` (`func : Box(Self)`).
The enum self-shell patch (types/enum.yo) replaces only ONE level of self-nesting;
the second-level `Box(Self)` deref surfaced the raw empty-variant shell, and the
match evaluator never called `resolve_enum_shell` → "variant Atom not found in
<enum:..._self_shell>" → swallowed at def-time → no ExprInfo → "Failed to
transpile". Found by instrumenting `_trial_eval_fn_body`'s swallow to print
`err.to_string()`. Fix: `resolve_enum_shell(matched_type)` in match.yo (mirrors
synthesizer.yo / property_access.yo). check ./std 152/152, corpus PASS 82.

SIBLING (codegen) — ✅ ALSO FIXED: the same self-shell leaked into C type
emission (a recursive enum's `Box(Self)` field emitted an empty C enum, "use of
empty enum"). Fixed by resolving shells in codegen's `_type_key_at` + `collect_type`
(codegen-local). Regression test `recursive_enum_nested_match.yo` in the corpus.
See `issues/fixed/yo-self-codegen-recursive-enum-self-shell.md`. This unblocks the
AstExpr (`Box(Self)`) recursive-enum codegen for the fixpoint.

## Arm-frame-depth check — ✅ FIXED (target.yo 2→0)

`merge_and_check_envs` (evaluator/utils.yo) threw "Frame level is different for
different cases" for a `cond`/`match` that MIXES a `begin`-block arm (pushes its
own binding frame) with a simple-expr arm — non-uniform total depth. yo-self
evaluates each arm under a per-arm `push_frame` (a divergence from TS, where arm
envs sit at the outer level), so the ported strict total-depth equality was
wrong here. Fix: require each arm env to CONTAIN the outer frames
(0..max_frame_level — the only frames the post-check ownership loop scans), not
match total depth; the per-frame variable-count check remains the soundness
guard. target.yo 2→0, std 152/152, corpus PASS 83.

## Candidate 3 — ✅ RESOLVED (trivial nested-match arm drops an enclosing binding)

FIXED in merge_and_check_envs (evaluator/utils.yo): treat a case var MISSING from
an arm's recorded frame as the BASE var (it retains its pre-match state) rather
than `make_err_variable`, at BOTH the variable-names check and the per-column
consume/init merge. A trivial arm (`.None => .None`) records no copy of an
enclosing destructure binding (`self_al`) that the base + destructuring sibling
arms carry; since that binding was init'd BEFORE the match, an arm that doesn't
re-bind it simply retains the base state. This keeps genuine partial-consume/init
detection intact (a consuming arm keeps the var in its frame with consumed_token).
naming_checker.yo 1→0 (std/string/string.yo's `index_of` — and all
`.index_of`/`.contains`/`.find`), check ./std 152/152, no regression. Details
below for history.

### Original diagnosis (kept for history)

`std/string/string.yo:516` `index_of` (surfaced via naming_checker.yo): the
function body is `cond(simple => .Some(i), true => begin(… match … begin(…
while(… return(.Some(char_index)) …), return(.None)) …))` — embedded `return`s
deep inside a `begin` that is itself a `cond`/`match` arm in RETURN position.
After the arm-frame-depth fix above, index_of's def-time eval now throws (still
swallowed → no ExprInfo) **"Frame level 4/5 has different variable names for
different cases"** (evaluator/utils.yo:812). Confirmed via the printing-swallow
instrumentation. ROOT: `merge_and_check_envs` has THREE strictness checks
(depth=702, value-count=768, variable-names=812) that all require arms to share
an IDENTICAL frame/variable layout at every level 0..max_frame_level. A
`begin`-block arm's `:=` bindings (e.g. `char_index`/`byte_index`) land in a
scanned frame that a simple sibling arm (`.None => .None`) does not have — so the
names/counts diverge. PRECISE ROOT (instrumented the names-check, DBG_NAMES dump):
```
frame=4/max=4 kk=0 base.len=1 case.len=0 base[kk]=self_al   case[kk]=__err__
frame=5/max=5 kk=0 base.len=1 case.len=0 base[kk]=search_al case[kk]=__err__
```
i.e. it is NOT the begin-arm adding locals — it is the TRIVIAL arm DROPPING an
outer binding. In the nested `match(self._bytes, .None => .None, .Some(self_al)
=> match(substr._bytes, .None => .None, .Some(sub_al) => begin(…)))`, the inner
match's env (base) has the OUTER destructure binding `self_al`/`search_al` at
frame 4/5, but the trivial `.None => .None` arm's recorded env has that frame
EMPTY (case.len=0). So the names check compares `self_al` vs missing and throws.
In TS every arm env retains the outer bindings (arms sit at the outer level), so
this never arises — it is a yo-self recorded-env divergence: a trivial match arm
records a shallower/emptier env than its siblings, losing an in-scope outer
binding. (Disabling the names check alone does NOT clear index_of — the layout
inconsistency also affects the count check / per-column merge.)

ATTEMPTED (reverted): giving the names-check the same `frame_i !=
max_frame_level` innermost-frame exemption the value-count check already has
(at the innermost frame, arms legitimately bind different locals). This is a
correct consistency improvement BUT insufficient — index_of stays at 1, because
`self_al`/`search_al` is NOT an arm-local here: it is an ENCLOSING-destructure
binding that happens to sit at the inner match's innermost frame (the inner
match is nested inside the outer `.Some(self_al)` arm). So the per-column merge
(utils.yo:826+) still processes it as a shared var and the missing-in-`.None`-arm
inconsistency resurfaces. The innermost exemption can't cleanly cover it.

FIX (deep, soundness-sensitive — fresh task): the right fix is (a) — make a
TRIVIAL arm's recorded env carry the same enclosing-frame bindings (`self_al`)
that its sibling arms and the base retain (match.yo arm-env recording / per-arm
frame management). That makes ALL the merge checks (depth/count/names/per-column)
see a consistent layout at once, matching TS (where arm envs sit at the outer
level with enclosing bindings intact). Relaxing the individual checks is
whack-a-mole (each fix exposes the next) and risks the consume/init merge
soundness. Affects ALL `.index_of`/`.contains`/`.find` users — high value.
Related: the now-compiling `target.yo` and OPEN
`issues/yo-codegen-block-rhs-drops-statements.md`.

## Method

`compile <m>.yo --emit-c --skip-c-compiler` + `grep -c "Failed to transpile"`;
minimal repro in `src/tests/fixme.yo`; if the node has no ExprInfo, instrument
the def-time trial-eval swallow (`_trial_eval_fn_body`,
`evaluator/calls/function_type.yo`) to print the swallowed throw; root-cause →
fix evaluator or emitter → re-measure → corpus-validate (now deterministic) →
commit. The corpus differential is reliable again post-P0.
