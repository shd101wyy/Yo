# yo-self P1 — executing-mode transpile-error tail (candidates)

## Status: OPEN — the P1 drain (lead, now that P0/corpus is deterministic)

Per-module `// Failed to transpile` markers, each a real executing-mode
evaluator/codegen gap. As of 2026-06-21 (after the Index-trait, cond/panic,
open-import, and P0 double-free fixes), the small/medium modules are near-clean:

Per-module status as of 2026-06-21 AFTER Candidates 1–3 + the frame-depth fix +
the specialization-Self fix + the receiver-arg-type fix:

| module | swallowed errors | note |
|---|---|---|
| `error/token/utils/lexer/expr/target/naming_checker` | **0** | ✅ all clear (Candidates 1–3 + frame-depth relaxation) |
| `value.yo` | **field_labels CLEARED** | `Self`-not-found ×4 (Self fix, 378914804) + `field_labels` (receiver-arg-type fix, 8910182ad) both RESOLVED. The 6 remaining `// Failed to transpile` markers are ALL `if(...)`-as-value COLLATERAL = the separate OPEN issue `yo-codegen-block-rhs-drops-statements`, NOT new transpile gaps. `and` bool-arg: likely also cleared (sibling self-first-method class — re-verify with DBG_SW). |
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
