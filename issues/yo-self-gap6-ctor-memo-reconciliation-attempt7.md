# Gap-6 attempt #7: ctor-memo reconciliation at signature re-resolution (REVERTED — dyn identity + multi-canonical anomaly)

**Status: REVERTED 2026-07-22** per the gates rule (corpus regressions), but
this attempt got the FLAGSHIP REPRO FULLY GREEN and produced the sharpest
map of the family yet. Read this before attempt #8.

## The flagship repro (KEEP — 12 lines, exercises the whole family)

`/tmp/yo_gap6_list.yo` (recreate: std/imm/list List(i32) new+prepend×3+len+
head+tail+asserts+println, `main :: (fn() -> unit)`, `export(main)`).
TS: `ok 3`. Committed-tree s2: 3 clang errors —
`passing '__yo_t1' to parameter of incompatible type '__yo_t7'` — the
imm\_\*/collections class in miniature.

## Probe-verified mechanism of the split (NEW ground truth)

1. `[CTFE]`/`[CTFERES]` probes in `evaluate_comptime_fn_call`
   (evaluator/calls/comptime_fn.yo): the `should_cache=false` gate (slice 2b:
   any TYPE arg containing SomeTs skips the memo) makes EVERY def-time /
   validation-generation instantiation of `List(T)` / `ListNode(T)` mint a
   FRESH struct id (~15 instances per compile: 4942, 4948, 4953, 4955, 4981,
   4995, …). The CONCRETE calls (`args=int`, sc=true) mint the canonical pair
   `List(i32)=5100` / `ListNode(i32)=5102` — memoized correctly.
2. The IMPL PATTERN instance (`List(T#1972)` = 4953, from the impl's
   def-time eval) LEAKS into user code: main's `xs` C type was 4953 while
   `prepend`'s spec body built values from the concrete 5102 lineage — one
   expression mixing both (the clang error site). The pattern instance
   arrives through impl-candidate `Self` (env-bound to the pattern-era
   instantiation) at spec-signature construction:
   `spec_result := evaluate_function_return_type_again(sp_res_b, callee_env)`
   (helper.yo:1795) returns 4953 with `type_arguments=[T#1972:unres]` — yet
   `[SPECARG]` proved `get_value_of_some_type_from_env(callee_env, T#1972)
= int`. The SomeT lives ONLY in the struct's `type_arguments` metadata,
   which `get_all_some_types` does NOT walk — so no existing resolution path
   ever concretizes it.
3. In TS none of this arises: the CTFE cache lives ON the FunctionValue
   (object identity; TS `shouldCache = isTypeHierarchyType(return)` ONLY —
   no some-containing-arg skip — abstract instantiations are memoized per
   SomeType-id too), and TS "substitution" re-evaluates type EXPRESSIONS
   through that cache, so signature-side and body-side always converge on
   the same type object.

## What was built (all reverted; reproducible from this description)

- `types/substitution.yo`: injected `CtorMemoLookupFn` indirection
  (`set_ctor_memo_lookup` / `ctor_memo_canonical`), wired on first CTFE call
  from comptime_fn.yo (`_ctor_memo_lookup_impl`: bucket by ctor fid, args
  compared via `_ctfe_args_equal` on `TypeVal`-wrapped type args, resolved
  entries only via `_resolved_type_of`).
- `evaluator/types/function.yo`: `_reconcile_resolved_struct_from_env(t, env)`
  — for a ctor-stamped struct, resolve each `type_arguments` SomeT (own cell,
  then env), and when fully concrete swap to `ctor_memo_canonical(...)`.
  Applied at ALL FOUR exits of `_resolve_some_types_deep` (the
  `evaluate_function_{parameter,return}_type_again` engine). NOTE: the
  crucial exit is the `get_all_some_types(ty).len()==0 → return(ty)` one —
  the pattern-era instance has NO walkable SomeTs.

**RESULT: the flagship repro compiled AND ran (`ok 3`, 0 errors).**

## Why it was reverted — two failure modes (both probe-verified)

1. **dyn identity correlation** (corpus `dyn_dispatch_autobox_value`,
   `dyn_error_throw_ioerror`; with the substitute()-arm variant also
   `closure_param_capture`, `dyn_fn_field`, `dyn_fn_same_sig_closures`):
   ONE swap (`[SWAP] cfid=yo_id_2743 (prelude Box) old=2746 new=2942
had_some=false`) breaks the auto-box chain — output `0x00` instead of
   `'Q'` (box data reads zeros). The dyn box/typeid/vtable registrations key
   off a specific instance id; canonicalizing the signature side de-correlates
   them. `had_some=false` (already-concrete instance swapped by pure memo
   preference) is exactly the poisonous case here.
2. **Guarding on had_some breaks the fix**: requiring "at least one tyarg
   was an unresolved SomeT" (attempted twice, incl. the first
   substitution.yo-arm variant) re-broke the repro (t1/t7 back) — the List
   family NEEDS the had_some=false swaps too (concrete-but-noncanonical
   instances flow through signatures).
3. **Multi-canonical anomaly** (the deepest finding): in the repro compile,
   `[SWAP]` showed the SAME old ArrayList instance (`old=struct_yo_id_3049`,
   ctor `yo_id_3044`) swapping to THREE different "canonicals" (3214 ×244,
   3259 ×14, 3761 ×10) — the memo holds multiple entries whose args all
   match 3049's resolved tyargs, and first-match depends on call context.
   Post-hoc id-level canonicalization is therefore not just risky for dyn —
   it is ill-defined: the memo itself contains duplicate-keyed entries
   (likely `_ctfe_args_equal`'s struct-id fast path vs structural fallback
   admitting several u8-arg instantiations).

## Direction for attempt #8 (do NOT re-run #7 with more guards)

Fix the CREATION side, not the consumption side:

- **(a) Impl-candidate `Self` should be the RECEIVER instance** (TS:
  `context.SelfType = dereferencedReceiverType`), not
  substitute(pattern-instance). The receiver at main's call IS canonical
  5100; every spec signature derived from it would be canonical natively.
  The machinery partially exists (`_static_dot_receiver_self_type`,
  ctx.self_type save/set/restore in calls/function.yo ~:1360); the gap is
  that `evaluate_function_return_type_again` resolves `Self` through the
  ENV (pattern-era binding from `_inject_forall_captures`) rather than
  ctx.self_type.
- **(b) De-duplicate the memo**: investigate why `_ctfe_args_equal` admits
  multiple ArrayList(u8)-shaped entries (the ×3-canonical anomaly) — fixing
  THAT may be prerequisite to any memo-based approach and could fix
  cross-module unification failures on its own.
- **(c) The `should_cache=false` gate divergence** (slice 2b vs TS's
  cache-everything): TS memoizes abstract instantiations keyed by SomeType
  id. Porting that faithfully would collapse the ~15 def-time instances to
  ~1 per (ctor × T-instance) and shrink the split surface, but slice 2b
  exists because yo-self's placeholder entries once leaked to codegen —
  re-attempt only with the comparator fixed (b).

Gate battery used here: flagship repro + corpus (`YO_SELF_BIN=... 
scripts/diff-test.sh tests/codegen-bootstrap --parallel 4`, baseline
PASS 139 / DIFF 1) + `check ./std`. The dyn corpus files are the canaries
for any identity-touching change.

---

## Attempt #8 round 1 (2026-07-23, IN FLIGHT — uncommitted tree, probes active)

Direction (a) receiver-adoption implemented and probe-verified FIRING, but the
flagship repro still fails with the same 2 clang errors. New ground truth:

### Probe-verified mint map (G6PROBE ctfe-mint, ids from one run)

- `yo_id_4979` = List ctor, `yo_id_4971` = ListNode ctor, `yo_id_2435` = `?()`.
- Def-time generations mint PATTERN instances NOCACHE (List 4987/5034/5072/…,
  ListNode 4989/5015/… each with `some:N` args) — as attempt #7 recorded.
- **NEW: the pattern generations poison the DURABLE memo.** Each generation's
  `?(ListNode_pattern)` entry is **cached** (`ctfe-mint fid=yo_id_2435 ->
enum_yo_id_4991 args= struct_yo_id_4989 cached` where 4989 is NOCACHE
  pattern!) because the slice-2b NOCACHE gate uses `type_contains_some_type`,
  which does NOT walk `type_arguments` — the same blind spot as everywhere
  else in this family. One durable Option-of-pattern entry per generation.
- The CONCRETE lineage is minted LAST and is fully self-consistent:
  `ListNode(i32)=5136 → ?(5136)=5138 → List(i32)=5134` (all cached, args
  match).
- The emitted C nevertheless keys everything on the FIRST pattern lineage:
  `__yo_t0 = struct_yo_id_4987` (pattern List) with `_head : __yo_t1 =
enum_yo_id_4991` (Option-of-pattern), while the concrete `__yo_new___yo_t6`
  (ListNode 5136) wants `_next : __yo_t7` (5138) — the 2 clang errors.
  The UNSPECIALIZED `new` emission (`yo_id_4993()`) is CORRECT (t1); only the
  SPECIALIZED `yo_id_4993__ret_gs_..._i32()` builds `.None` as t7 against a
  t0 return — spec body evaluated in the concrete lineage, signature/binding
  still pattern.

### What was built (ON DISK, uncommitted, mixed with probes)

- `expr_info.yo`: shared `struct_effective_ctor_fid` /
  `struct_fully_concrete_instance` (walks type_arguments!) /
  `adopt_receiver_struct_instance(ret, recv)` — same-ctor, different-id,
  fully-concrete receiver, TYARG-COMPATIBLE (unresolved ret tyarg after its
  own resolved_concrete cell = wildcard; resolved must match positionally by
  type_to_string).
- Adoption applied at FOUR sites, all probe-verified firing (`adopt-static`,
  `adopt-inst`, `adopt-rt`, `spec-adopt` on the concrete List(i32)):
  1. calls/function.yo runtime-arm spec block (static + NEW instance twin
     `_instance_dot_receiver_self_type`), updating out_rt.ty/value;
  2. calls/function.yo runtime-arm BEFORE out_rt stamping (methods without
     foralls — `new`/`prepend` — never reach the spec block);
  3. calls/helper.yo create_specialized spec_result (self-arg receiver, or
     ctx.self_type for statics — the dispatcher set it);
  4. types/function.yo evaluate_function_return_type_again (central exit,
     adopts ctx.self_type).

### Why it STILL fails — the remaining wall

The spec functions' C signatures and body temps come from the SPECIALIZED
BODY's own ExprInfos, evaluated in callee_env where the `self` PARAM VARIABLE
is bound with the DECLARED (pattern-era) Self type. ctx.self_type is set to
the receiver around the body eval (helper.yo:1581-1614) but the `self`
variable's TYPE in callee_env stays pattern — every `self._head` etc. types
pattern-lineage, and codegen emits the spec signature/body from those.
**Next: bind the `self` parameter (and Self-typed params generally) in
callee_env with the receiver ARG's concrete type during try_to_call's param
binding — that is where TS actually converges (params bound with arg types).**
Also worth testing independently: fix the slice-2b NOCACHE gate to walk
type_arguments (would stop the durable Option-of-pattern entries — candidate
(c-prime)), and (b) same-ctor structural match in `_ctfe_args_equal`.

### State / hygiene

- Probes active: G6PROBE in calls/function.yo, calls/helper.yo,
  calls/comptime_fn.yo (ctfe-mint tracer). STRIP before any gate run.
- NO gates run on these edits (183-sweep was running; corpus/battery would
  conflict). The r8 committed baseline is clean; `git checkout` of the five
  touched files (expr_info.yo, types/function.yo, calls/function.yo,
  calls/helper.yo, calls/comptime_fn.yo) restores it.
- Flagship repro errors unchanged throughout (2 clang errors) — the adoption
  work is NECESSARY (receiver-canonical signatures) but NOT SUFFICIENT
  without the param-binding piece.

### Attempt #8 rounds 2-3 (same evening)

**Round 2 — param-binding adoption (helper.yo Step 9):** bind the param
variable with `adopt_receiver_struct_instance(final_pt, arg_type)` when the
declared param re-evaluates to a pattern-era sibling of the arg's ctor. Fires,
and together with the four round-1 sites the SPEC FID now embeds the CONCRETE
return marker (`..._ret_gs_yo_id_4945_i32`, was `..._1972`) — the signature
flow IS concretizing. The flagship repro STILL fails with the same 2 clang
errors: the emitted C keys the List struct on the FIRST-SEEN pattern instance
(`__yo_t0 = 4953-era`), so main's locals/protos still reference the pattern
lineage. Open question for round 4: which dispatch path stamps
`List(i32).new()`'s call ExprInfo — the runtime FuncVal arm's `out_rt`
(adopted) or the property-access/static-method arm (function.yo ~3198/3538,
NOT yet adopted)? Probe the property-access arm next.

**Round 3 — (c-prime) NOCACHE tyarg walk: ABORTS, REVERTED.** Gating
should_cache on `struct_fully_concrete_instance(arg)` (pattern-struct args →
NOCACHE) crashes the flagship compile with
`get_type_string: type not registered in context.types — u8` (rc=134,
reproducible): dropping the durable memo entry also drops the TYPE
REGISTRATION that codegen later reads. (c-prime) requires decoupling
context.types registration from memoization first. The edit is REVERTED;
everything else from rounds 1-2 remains ON DISK (uncommitted, probes active).

**Cost note:** each iteration = ~10 min s1 rebuild + ~2 min repro. The
ctfe-mint probe (comptime_fn.yo) is the single most valuable instrument —
keep it until the family is closed.

### Attempt #8 round 4 — FLAGSHIP GREEN, dyn canaries PASS, FIXPOINT HOLDS

The missing stamping site was the **method-dispatch arm** (`out_m` in
calls/function.yo, the path that types chained `.method()` results — probe
`bind-xs` showed the := RHS typed by it). With adoption there (`m_out_ty`),
the flagship repro **compiles AND runs (`ok 3`)** — and unlike attempt #7:

- battery 14/14 green INCLUDING **imm_list 16/16** and **imm_string 28/28**
  (both RED since the campaign began), plus all async/fs/struct files;
- **corpus diff-test PASS 140 / DIFF 0** — every dyn canary
  (dyn_dispatch_autobox_value, dyn_error_throw_ioerror, closure_param_capture,
  dyn_fn_field, dyn_fn_same_sig_closures) passes. Receiver-derived per-call
  adoption does not de-correlate the dyn box/typeid registrations the way
  attempt #7's memo-preference swaps did.

Final adoption-site list (all committed-to-be, probe-stripped):

1. expr_info.yo — shared `struct_effective_ctor_fid` /
   `struct_fully_concrete_instance` / `adopt_receiver_struct_instance`
   (same-ctor + different-id + fully-concrete receiver + TYARG-COMPATIBLE:
   unresolved-after-own-cell = wildcard, resolved must match by
   type_to_string).
2. calls/function.yo runtime arm: before `out_rt` stamping + inside the spec
   block (static SomeT case kept; pattern-instance case added; NEW
   `_instance_dot_receiver_self_type` twin) — ctx.self_type also set for
   instance receivers around specialization.
3. calls/function.yo CTFE arm: before `out_ct` stamping.
4. calls/function.yo method-dispatch arm: before `out_m` stamping (the
   decisive one).
5. calls/helper.yo create_specialized: spec_result adoption (self-arg
   receiver, ctx.self_type for statics) + Step 9 param BINDING adoption
   (bind `self` and Self-typed params with the arg's concrete instance).
6. types/function.yo evaluate_function_return_type_again: central adoption
   vs ctx.self_type.

Still red in quick probes (separate sub-classes, triage after landing):
imm*set / imm_map (deeper SortedMap/HashMap splits), rc / arc
(`Array_Array_Array*` nested fixed-array C emission), prelude.

Full chain verdict (first run, probe-residue imports still present):
battery 14/14, corpus PASS 140/DIFF 0, check ./std 153/153, STAGE2/CLANG/
STAGE3 all rc=0, **FIXPOINT_HOLDS**. The probe residue was then stripped
(comptime_fn.yo + initialization_assignment.yo reverted to HEAD, helper.yo
unused fmt open removed) and the WHOLE chain re-run on the exact commit tree
before landing.

### Post-attempt-8 sub-class map (2026-07-24, attempt #8 = commit 09cb5fd14)

Direct probes with the attempt-8 s1 against the remaining red families:

1. **Nested fixed-array wrapper ORDER (rc/arc/iso layer 1) — FIX ON DISK,
   gates pending.** `generate_array_struct_declarations` iterated
   `array_struct_types.keys()` — a HashMap, HASH order — while TS's Map is
   insertion-ordered with inner-first lazy registration (utils/index.ts:599),
   so a 4-level `[[[[Box(i32)]]]]` wrapper could be emitted before the
   3-level typedef it embeds by value ("unknown type name Array*Array*…").
   Fix: emit in (length, lex) order — dependency-correct and deterministic.
   Repro: issues/repros/nested-array-wrapper-order.yo (14 lines; TS green,
   pre-fix s1 red, post-fix s1 compiles AND runs). yo-self/codegen/types/
   generation.yo, uncommitted pending gates (sweep owns ./tests).
2. **Tuple instance split (rc layer 2).** After the array fix, rc.test still
   fails on `z._0 = (__yo_t51){…}` vs field type `__yo_t47` — the TUPLE twin
   of the anon-struct/receiver identity class: `z.0 = (box(10),)` mints a
   fresh tuple instance whose C id differs from the declared field's. Both
   synthesizers unify tuples structurally (no id check), so eval passes and
   only the C keying splits. TS also keys tuples BY ID (`context.types[
type.id].cName`, utils/index.ts:535) — its ids converge via object
   identity; yo-self's cannot. RECOMMENDED DIRECTION: key TUPLES structurally
   in yo-self's `type_key`/`stable_type_identity` (same field types ⇒ same C
   struct — tuples are structural types by definition), NOT another
   literal-adoption reroute (the round-8 broad-rule lesson: expected-type
   adoption at scale broke stage-2 self-emission; structural keying is
   value-semantics-native and cannot desynchronize).
3. **Undeclared `__yo_t28` (rc layer 3).** A C type referenced but never
   declared — a collection gap distinct from ordering; un-triaged.
4. **imm_set/imm_map:** un-specialized GENERIC called at runtime with Type
   args (`yo_id_5435` undeclared, `(// Unknown type: Type)` args) — the
   SortedMap-family specialization/supersession class; un-triaged.

### rc layers 2-3, refined (2026-07-24, post array-order fix 2319ccfc6)

Emitted-C evidence from the rc.test batch (`/tmp/.yo_selftest_batch_1.bin.c`):

- **Layer 2 — tuple key RENDER divergence, not an instance split.**
  `__yo_t51 = Tuple(0 : Box(V))` (keyed with the UNRESOLVED `V` render) vs
  `__yo_t47 = Tuple(0 : Box(i32))` — and both have the IDENTICAL C layout
  (`__yo_t18* _0`, the SAME Box instance!). The tuple type_key embedded the
  evaluator render of a not-yet-resolved tyarg. FIX DIRECTION: key tuples by
  the RESOLVED C identity of their field types (both fields render
  `__yo_t18*` → one key → one C type) — layout-identical tuples must share
  the C type; never embed a SomeT name in a tuple key. (type_key.yo has NO
  Tuple arm — find the fallback it routes through.)
- **Layer 3 — a TYPE C-name in VALUE position.**
  `((bool (*)(void*))__yo_t28.can_isolate)(x)` — Iso `can_isolate` vtable
  access emitted `__yo_t28` (a type's C name, never declared as a value)
  where a vtable GLOBAL identifier belongs. Iso/dyn vtable emission path;
  affects rc/iso/arc.

### Tuple-key fix ON DISK (2026-07-24, gates pending)

`yo-self/types/type_key.yo`: explicit `.Tuple` arm in `_type_key_at` —
per-field RECURSED keys (labels included) instead of the
`_ => type_to_string` fallback that embedded the evaluator's tyarg spelling.
Verified: rc.test error count 3 → 2, the `__yo_t47`/`__yo_t51` tuple
assignment error is GONE. Run the full gate chain and commit (pattern:
scratchpad/gates_g9.sh with a fresh S1; /tmp/g10_s1 is the current tree's
s1 already built).

**rc layer 3 (last rc blocker), lead:** `((bool (*)(void*))
__yo_t28.can_isolate)(x)` — the trait-witness expression
`(T <: Isolation).can_isolate(x)` (prelude cycle-collector macro,
std/prelude.yo:7461) emits the witness VALUE as the type's C name. TS
resolves witness member access in evaluator values/impl.ts:2030 and codegen
emits a DIRECT call to the resolved impl method — find yo-self's
property-access/dot-callee path for a `<:` witness receiver and mirror the
direct-call resolution (yo-self evaluator counterpart:
evaluator/values/impl.yo:1400 area).

### rc layer 3 FIXED (witness member resolution) + layer 4 discovered (2026-07-24)

**Layer 3 fix ON DISK, gates running:** `(T <: Isolation).can_isolate`
witness member access — the previously Phase-3-skipped receiverType block.
`yo-self/evaluator/exprs/property_access.yo` TraitT arm now: when the
witness TraitT carries a receiver in `is_concrete`, resolve the method via
impl.yo's `find_methods_from_generic_impls` (the rich wrapper WITH
`_inject_forall_captures`) filtered by `candidate.source_trait_id ==
get_trait_key(trait)`, and stamp the resolved method type + VALUE (mirrors
TS property-access.ts:850 → findMethodFromGenericImplForTrait). NOTE: a
first attempt added a plain finder to generic_impl_registry.yo and imported
it directly from property_access — the TS compiler then emitted
`g_impl_registry_entry_lists` TWICE with different ArrayList instantiation
ids (redefinition; the TS compiler's own cross-module dup class!). Route
witness resolution through impl.yo's re-export layer like every other
caller. Repro: issues/repros/iso-witness-member-call.yo (11 lines).
Results: iso.test 3/3 GREEN (was red); rc.test now C-COMPILES and runs
14/15.

**Layer 4 (new, pre-existing behavior finally exposed):** rc.test "Test Rc
in different data structures" fails silently; probe (/tmp/rc_ds_probe.yo,
4 sub-blocks with printfs) shows under s1: the ANON-STRUCT block's prints
(a1/a2) never appear, nested-boxes (b1) + array chain (c1) print correctly,
then HEAP CORRUPTION (SIGBUS in malloc, EXC_BAD_ACCESS 0x4000...) at the
TUPLE block (d1). TS prints all four. So: anon-struct Rc-field block
miscompiles (silent skip + heap damage), tuple Rc chain crashes on the
damaged heap. This layer was NEVER exercised before (compile errors always
blocked it). arc/prelude still have their own C errors (t37/t39-vs-t3
passing mismatches — likely another instance-split family).

### rc layer 4 FIXED — rc.test 15/15 (2026-07-24, gates running)

Three stacked pieces, all Phase-3/4 "DEFERRED" stubs finally hit by real
Rc-bearing tests (the 4-block probe /tmp/rc_ds_probe.yo →
issues/repros/rc-array-tuple-dup-elision.yo):

1. **evaluator/builtins/dup.yo** — evaluate_dup's tuple/array RC branches
   were stubbed ("type_contains_rc_type is a stub" — long false). Ported:
   per-element `__yo_dup_tuple_element` / `__yo_dup_array_element` expansion
   via generate_expr_from_code + evaluate, stamping BOTH the original
   `___dup` node and returning the generated node (TS mutates in place).
   Struct `.___dup()` branch deliberately NOT ported (yo-self lowers
   ref-struct RC directly in codegen — documented divergence).
2. **evaluator/values/tuple.yo** — set_expr_as_needs_to_call_dup for field
   values was a stub comment; wired (mirrors tuple.ts:107).
3. **codegen/exprs/array_fns.yo + tuple_fn.yo** — the literal emitters now
   consume per-element deferred_dup_expressions (emit the dups, reference
   the dup-result temp in the literal — mirrors array-fns.ts:36-50 /
   tuple-fn.ts:36-48). **codegen/exprs/rc_fns.yo** — both element-dup
   emitters' `.None` fallback now calls generate_dup_code_for_value (direct
   `__yo_incr_rc` lowering) instead of emitting a `// No dup function`
   comment into expression position: yo-self has no synthesized \_\_\_dup
   trait methods for ref structs, so TS's getDupFunctionForType-style
   lookup can't ever find one there.

Verified: all five block-pair combos + the full 4-block probe print
byte-identical to TS; **rc.test 15/15** (was 14/15 with heap corruption).
arc/prelude keep their own separate C-error layers. g11 sweep (witness fix):
**158/183**, zero regressions (only iso flipped vs g8).

### arc/prelude class identified: closure-capture spec split (2026-07-24)

arc.test C errors are CLOSURE CAPTURE mismatches: the call site builds
`__yo_t37 __capture_closure_yo_id_6105_0 = {.shared = shared}` (capture
instance capture_yo_id_6109) and passes it to `yo_id_4934(...)` whose param
is capture_yo_id_6125 — one soft-generic specialization (Thread.spawn-like,
`cb : Impl(Fn(...))`) is REUSED across four different closures (6109/6125/
6139/6146 all `{shared}`-shaped): the specialization cache keys by the Fn
signature and ignores the capture struct, while codegen types each call
site's capture with its own closure's instance. Next hunt: the spec cache /
supersession keying in calls/helper.yo (`SpecializedFunctionCacheEntry`,
`arg_ty_spec := ainfo.capture_type` is used for the spec ARG type but
apparently not for the CACHE key) — TS specializes per closure because each
closure's type is a distinct object. Likely also prelude.test's class.

### arc/prelude capture-split FIX (2026-07-24, gates pending)

Minimal repro pinned first (issues/repros/arc-spawn-capture-split.yo, 23
lines): two blocks each `arc(N)` + `Thread.spawn((io) => assert(shared.*
== N))` — TS prints p1/p2, s1 dies at clang with `passing '__yo_t15' to
parameter of incompatible type '__yo_t14'`.

Root cause (TS diff): TS's computeCompileTimeSignature includes
`_id${paramType.id}` for every runtime param with a type id
(helper.ts:2176), and its cache lookup compares runtime types with STRICT
type-ID matching (helper.ts:2290). Each closure LITERAL's FunctionType is
a fresh object with a unique `.id` — so two same-signature closures can
never share a specialization in TS. yo-self's FnTraitT has no ids and
compares structurally: `are_types_compatible_exact` said "equal", the
first closure's spec was reused, and each call site still typed its own
capture struct.

Fix (calls/helper.yo, main spec path only — the `_ctl_` path keys by
concrete type already): a closure arg's `func_id` is the yo-self
equivalent of TS's type identity. For every arg whose VALUE is a FuncVal,
fold `clfid<i>_<func_id>` into the compile-time cache key (the same
extra-key pattern as ret*sig_ty — `compile_time_args` extras are
cache-key-only) and append `\_cl<i>*<fid>` to the specialization sig so
distinct closures also get DISTINCT emitted func_ids. Deliberately NOT
touching runtime_param_tys (appending there changed C call arity and
regressed massively — warning at the degenerate-unit gate). Same-literal
re-calls share a fid → still cache-hit; two different literals split —
exactly TS's behavior.

**Round 2 (same day): cache split alone was NOT enough — repro now GREEN
with three layers.** With only the clfid keying, the repro C flipped its
error direction (t14-into-t15): two correctly-typed specs were minted but
(a) BOTH call sites still emitted the bare `yo_id_4934` — codegen's
method dispatch reads the method-callee VALUE side-table and falls back
to the type*trait_methods registry FIRST-HIT (the original generic); the
inline-FuncVal arm only stamped func_expr's ExprInfo, which that dispatch
never reads — and (b) spec-1's emitted BODY malloc'd closure-2's capture
and all three spawn wrappers called closure-2: the closure-param rebind
registered each spec's capture on the SHARED declared-SomeT id
(register_some_resolved_concrete last-write), exactly the HAZARD the
SomeT.resolved_concrete doc warns about. Fixes: (2) function.yo's spec
block now records the specialized FuncVal in the method-callee side-table
for DOT-callee calls (mirrors TS lowering calls to the RESOLVED
FunctionValue); (3) helper.yo's closure-param rebind binds the param to a
PER-SPEC REBUILD of the SomeT (fresh `<sid>\_capbind*<capture type_key>`
id + own resolved cell), keeping the shared-id registration for legacy
consumers. Repro prints p1 42/p2 7 — byte-identical to TS. Gates part A
(std + stage2/3 fixpoint) running; battery + corpus queued behind the g14
sweep.

### Next round staged: inline-arm spec gate broadening (probe-validated)

The imm*set/imm_map/sorted*\* class root cause: `Map.insert`'s spec body
calls `_node_insert(K, V, ...)` — a module-level helper with
`comptime(K/V) : Type` params and SomeT runtime params, NO foralls, NO
closure param. The inline-FuncVal arm's spec gate
(function.yo `ou_spec_soft_generic`) requires
`_func_type_has_closure_param` — a narrowing TS does NOT have
(helper.ts:1911 gates on `isFunctionTypeGeneric` alone, guards.ts:457) —
so the call emitted the BARE generic fid with Type args as runtime C args
("call to undeclared function 'yo_id_5430'",
`(// Unknown type: Type)(...)`). Dropping the closure-param requirement
on a TREE COPY (/tmp/yoself_gatecopy → /tmp/cf3probe_s1):
imm_map probe GREEN (8-line repro /tmp/imm_map_probe.yo), sorted_map
probe GREEN, arc capture-split repro still GREEN, `check ./std` 153/153.
Apply to the real tree AFTER the capture-split round commits (tree locked
by its stage2/3 emits until then).

ordered_map is a DIFFERENT class (unchanged by the broadening): main body
"Failed to transpile m := (OrderedMap(String, i32).new)()" + a
`dispose_fn = yo_id_5459` referencing a never-emitted drop method —
ref-struct with HashMap/ArrayList fields; next-next round.

### Residual-red classification vs capture-split s1 (2026-07-24)

Gates part B: arc FLIPPED (15/15); prelude unchanged (its sole failure is
the comptime_int forall-inference leak —
issues/yo-self-comptime-int-forall-inference.md); thread/worker ADVANCED
a layer (baseline t20-t23-vs-t29 capture mismatches → now async-SM
`sm->var_NNN` / `void` variable errors); zero regressions (16/16
baseline-green battery files pass, corpus 140/0). g14 sweep confirmed
the committed baseline 159/183.

Extra probes with the same s1:

- sync/atomic: `__yo_new___yo_t14` undeclared (ctor never emitted).
- sync/once: capture-type mismatch remains — stored-closure path
  (Once callback held in a field?) not covered by the call-arg split.
- ref_closure_capture: returning t22 from incompatible-result fn
  (closure return identity).
- closure_capture_rc_leak: call to
  `yo_id_2889__unknown__Type__fn_item...` — sig built with "unknown"
  forall segments; call-site/spec name divergence.
- imm_sorted_map / imm_vec / imm_threading: rc=137 at the 900s sweep
  timeout (STALL class) — re-check after the spec-gate broadening.

### Round-2 correction: gate broadening alone produces HOLLOW greens (2026-07-24)

The cf4 chain's early flips were partly VACUOUS: probe binaries compiled
rc=0 but their C contained `// Failed to transpile m = (m.insert)(...)`
for every main-body statement (sorted_map probes: 3 markers; imm_map
probes: 4) — bodies silently skipped, asserts never executed. Loud
"undeclared function" failures became silent hollow ones. TS emits ZERO
such markers for the same probes. GATE HYGIENE (all future rounds):
repro gates must diff the emitted C's "Failed to transpile"/"Unknown
type:" marker counts against the TS emit, and battery flips must be
spot-verified non-vacuous.

Real root (TS ground truth, /tmp/imm*map_ts.c): TS splits parameters by
isCompileTimeOnly — a comptime positional arg's VALUE becomes a leading
sig segment (`\_node_insert_i32_idi32_i32_idi32_rtparam0*...`) and joins
the compile-time cache key; the spec's C signature, registered type, and
every call site carry ONLY the 5 runtime params; direct SELF-recursion
inside the spec body re-targets the spec via the forward-ref
(helper.ts:1856→1999). yo-self's "Phase 3 simplification" pushes ALL
regular args into runtime_param_tys — so comptime Type args poison the
spec type (emission skipped as generic / "Unknown type: Type" C params),
the folded-const rebind DESTROYS the body's K/V TypeVal bindings
(rebound to UnknownVal), and direct self-recursion is skipped rather
than forward-referenced (bare fid at the recursive call). Fix plan (the
REAL round 2, on the tree copy first):
(a) create_specialized_function_inline: get_func_param_comptime flags →
comptime args' values into compile_time_args; runtime_param_tys
runtime-only; (b) compute_compile_time_signature: add TS's
compile-time-regular-params block (helper.ts:2155); (c) binding loop
skips comptime params (keeps try_to_call's TypeVal bindings) with a
separate runtime index; (d) spec type: filtered param_types/labels/
is_ref/is_owning masks; (e) inline arm + call sites: runtime args
exclude comptime args; (f) direct self-recursion → forward-ref like
TS. Gate broadening itself is KEPT (it is TS's guard) — it just
needs (a)-(f) underneath it.

### Round-2 REAL implementation landed in tree (2026-07-24 evening)

All of (a)-(f) from the plan above, in calls/helper.yo + calls/function.yo:
compile-time-regular-params sig block (new param_ct_flags arg on
compute_compile_time_signature); flag-split arg loop in
create_specialized_function_inline (comptime values → compile_time_args,
runtime_param_tys runtime-only); decl_runtime_pts for the degenerate
check + spec-type param sources; rebind loop skips comptime params
(preserving try_to_call's TypeVal bindings — the folded-const rebind was
DESTROYING them) with a separate runtime cursor; spec type registers
runtime-only param_types/labels/is_ref/is_owning; inline arm's
runtime_arg_exprs excludes comptime args (evaled_arg_infos stays
positional-complete); DIRECT self-recursion now forward-refs the
in-progress spec like the mutual case (TS helper.ts:1850-1856/1999) —
explicit self-calls no longer emit the bare generic fid. Probe harness
scratchpad/probe_cf5.sh enforces markers==0 (no hollow greens).

### Round-2 outcome: REVERTED from tree; full diagnosis preserved (2026-07-24 night)

The complete round-2 stack (gate broadening + faithful comptime-param
model (a)-(f) + comptime-generic gates in ou_spec/is_func_generic/
\_is_generic_unspecialized_func + record-overwrite guard) was probed
through eight instrumented s1 builds (cf5-cf16) and REVERTED per THE
METHOD: it converts the imm-family failures from loud C errors into a
SILENT-ABORT class rather than fixing them end-to-end. The tree is back
at the capture-split commit (99ba71265, gated green, 160/183 expected
with arc). The full WIP diff is saved at
scratchpad/round2_param_model_wip.patch (707 lines, apply with
`git apply`).

Probe-established facts for the re-approach (all with the WIP tree):

1. `m.insert(...)` on Map(i32,i32): property access intentionally defers
   methods to the call; `_try_find_receiver_method` FINDS insert
   (hits=1, instance dispatch, recv=<struct:struct_yo_id_6052>); its
   param matching SUCCEEDS (key/value declared=resolved=i32); the
   failure is DEEPER — during the specialized body eval — after which
   the ENTIRE remaining main-body eval silently stops (no further
   evaluate_function_call entries; every later statement emits
   `// Failed to transpile ...`) while compile exits rc=0.
2. `check` mode on the same file prints the real class then reports
   "evaluator OK": `Expected: <struct:struct_yo_id_5582> / Given: unit`
   (call result degenerated to unit) and `Expected:
*(<struct:struct_yo_id_5369>) / Actual: *(<struct:struct_yo_id_6062>)`
   — a POINTER-typed pattern-era-vs-concrete instance mismatch: the
   Gap-6 spec-identity family INSIDE the newly-activated specialized
   bodies. This — not the parameter model — is the blocking layer.
3. The parameter model itself verified sound on its own paths: with it
   (cf5/cf6), arc + rc repros stay green (markers=0) and raw generic
   originals stop being emitted once \_is_generic_unspecialized_func
   knows about comptime params (cf6 imm_map compiles; cf5's "invalid
   storage class specifier" gone).
4. Gate hygiene tooling added: scratchpad/probe_cf5.sh (markers==0
   enforcement); the marker-count-vs-TS-emit comparison is mandatory —
   TS emits ZERO markers for all these probes.

Re-approach order for round 2': (i) fix the pattern-era instance leak
that the specialized bodies hit (the _(<5369>)-vs-_(<6062>) unify — the
receiver-instance adoption machinery (attempt #8) does not yet cover
POINTER-wrapped Self in spec bodies); (ii) fix the silent-abort so this
class can never produce rc=0 hollow C (the main-body eval stop with no
propagated error is its own bug — probably an effect-handler unwind
being caught at the statement loop); (iii) re-apply the WIP patch;
(iv) full gates.
