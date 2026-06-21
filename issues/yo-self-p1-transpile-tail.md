# yo-self P1 — executing-mode transpile-error tail (candidates)

## Status: OPEN — the P1 drain (lead, now that P0/corpus is deterministic)

Per-module `// Failed to transpile` markers, each a real executing-mode
evaluator/codegen gap. As of 2026-06-21 (after the Index-trait, cond/panic,
open-import, and P0 double-free fixes), the small/medium modules are near-clean:

Per-module status as of 2026-06-21 AFTER Candidates 1–3 + the frame-depth fix:

| module | errors | note |
|---|---|---|
| `error/token/utils/lexer/expr/target/naming_checker` | **0** | ✅ all clear (Candidates 1–3 + frame-depth relaxation) |
| `value.yo` | 6 | `if(...)`-as-value/statement failures — CONTEXT-DEPENDENT (see below) |
| `parser.yo` | ~8 | mostly benign std/string begin-block arms + macro array_list |

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
fixing it should also clear the collateral `if`-markers in those functions. NEXT:
correlate each swallow to its function (instrument the swallow to also print the
body's first token / fn name) → fix the `Self` binding in the def-time eval.

The other big modules (`function.yo`, `helper.yo`, `codegen_c.yo` TIMEOUT >240 s;
`match.yo` SIGABRTs) are slow/heavy standalone even with the big stack — their
tail + the unified self-host fixpoint remain gated on P2 (memory / compile-time)
or a 32 GB+ box.

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
