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
