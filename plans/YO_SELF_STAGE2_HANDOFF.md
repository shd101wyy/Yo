# yo-self Stage-2 Handoff — #69/#70 Campaign

_Last updated 2026-07-19 (agent handover). This file was rewritten from
1450 lines of session logs down to the actionable map; `git log` of this
file has the full archaeology — do not re-litigate fixed bugs._

**READ THIS WHOLE FILE FIRST.** Deeper evidence (every probe, dead end, and
reverted candidate of the async/dispose/spec families) lives in
`issues/yo-self-async-emission-cluster.md` — consult it before re-deriving
anything about those families.

## SESSION UPDATE 2026-07-21 (late-4) — dyn FLIPPED 8/8 (#69 +1, 142/183) — `*(Self)` missed by the Self-level finder

- **dyn.test.yo GREEN 8/8** — every `dyn(box(<value>))` dispatch aborted
  (rc=134): ALL vtable wrappers were `abort()` stubs because
  `should_skip_function_codegen` saw the impl methods as hard-generic — their
  REGISTERED func type was still `fn(self : *(Self))`.
  `_find_self_level_in_method_ty` (evaluator/values/impl.yo) scanned only
  TOP-LEVEL SomeT params/return — `*(Self)` is `Pointer(SomeT)` and fell
  through → no substitution at impl registration. FIX: Pointer cases in the
  finder (substitute() already walks pointers once the level is known).
  **Same landmine family as type_id_or_empty's missing Pointer case — any
  type-shape dispatch without a Pointer arm silently no-ops for
  pointer-receiver methods.** Write-up:
  `issues/yo-self-dyn-pointer-self-subst.md`. Probe methodology: eprintln at
  the vtable skip decision printing `get_func_type(fid)` — one build cycle.
- **cycle_collector 15/16 root SCOPED PRECISELY** (not fixed — RC-ownership
  semantics arc, HIGH regression risk): repro `/tmp/gc_repro.yo` — s1's
  mid-scope `Gc.collect()` frees NOTHING (`tracked=3`; TS collects the a↔b
  cycle → 1). Emitted-C diff: s1 adds `incr_rc(<local>)` (deferred
  ref-handle dup) before EVERY `.Some(<owned local>)` ENUM-CTOR arg — the
  locals keep +1, the cycle has external refs, never garbage until scope
  end. TS emits NO dup AND NO scope-end drops for those locals — ctor args
  transfer/share ownership (TS shared-ownership model:
  `findRcValueOwnerRelationship` / `isOwningTheSameRcValueAs`; NOT the
  own()-param move path — enum ctor params aren't `own()`). Fix = find the
  yo-self eval site attaching the deferred dup to enum-ctor atom args and
  port the ownership-sharing decision. Full battery mandatory (RC semantics).

## SESSION UPDATE 2026-07-21 (late-3) — json FLIPPED 35/35 (#69 +1, 141/183) — recursive-enum element retain, 3 stacked shell/dup gaps

- **encoding/json GREEN 35/35** via three stacked fixes (write-up:
  `issues/yo-self-recursive-enum-element-retain.md`; corpus guard:
  `tests/codegen-bootstrap/recursive_enum_element_retain.yo`):
  1. `emit_deferred_dup_or_code` gained TS's declare-first step
     (assignment.ts:184-199 / other-fn-call.ts:2277-2292) — a ctor arg's
     deferred dup was suppressed as undeclared (`return(.Some(values(i)))`,
     the object `.get` rc=137 UAF). Subsumes+removes the previous commit's
     assignment-local helper.
  2. `type_contains_rc_type` resolves recursive-Self SHELLS (fifth site) —
     the specialized `ArrayList(JV).push` param type was the empty shell →
     contains-rc=false → the eval marker skipped the element retain
     ("one EvalValue push retained, its twin didn't" — SOLVED).
  3. `generate_dup/drop_code_for_value` resolve shells (sixth site) — with
     (2) fixed, the dup emitted as `switch(tag){ default: break; }` — ZERO
     arms (walked the shell's empty variant list): a silent no-op +1.
- **THE SHELL PATTERN (6 sites now):** any consumer walking struct fields /
  enum variants may receive a value-copied recursive-`Self` SHELL and
  silently compute "nothing here". New walkers MUST
  `resolve_enum_shell(resolve_struct_shell(ty))` first.
- **DEBUG LEDGER METHOD that cracked it:** instrument a /tmp COPY of the std
  module (fix relative imports to absolute), probe PRE-PUSH/POST-PUSH — value
  intact through push, dies at the recur-Result temp drop ⇒ missing retain,
  not an over-drop. Then diff the SPECIALIZED push bodies: T=String had 8
  dup ops, T=JsonValue (recursive enum) had 0.
- **regex m2 NARROWED to a 2-test minimal repro** (saved /tmp/re_j2.test.yo):
  "Chinese alternation" + "flag i: basic case insensitive" in one batch → 7
  `undeclared m2` C errors. Trigger needs BOTH m1 AND m2 flowing through
  `assert(mX.unwrap().value() == <MULTIBYTE>)` in the FIRST test; ASCII-ized
  passes; dropping the last multibyte compare passes. Mechanism: the poison
  block leaks its m1/m2 bindings into later blocks' envs (drop lists in the
  VICTIM's early-return blocks reference the poison's m2 — undeclared in C).
  Env-leak family (swallowed eval abort mid-block?). Not yet fixed.

## SESSION UPDATE 2026-07-21 (late-2) — recursive-enum sizeof=0 heap corruption FIXED (json + recursive_enum roots)

- **THE json `[1, 2]` CRASH ROOT (and recursive_enum's ArrayList(Self) fail):**
  `sizeof(T)` inside the SPECIALIZED ArrayList.push grow folded to **0** for a
  recursive enum — the C emitted `__yo_realloc(old, (0ULL) * new_capacity)`,
  push wrote a full 24-byte enum into the 0-byte buffer, and the corruption
  surfaced as SIGTRAP in a LATER malloc (lldb bt = mfm_alloc; looked like an
  RC bug for hours). Root: `get_size_of_type` walked the recursive-`Self`
  SHELL (value-copied, EMPTY variant fields → aggregate math = exactly 0). TS
  never sees shells (type objects shared by identity). FIX
  (`types/utils.yo`): resolve `resolve_enum_shell(resolve_struct_shell(ty))`
  at the entry of BOTH get_size_of_type and get_alignment_of_type — the
  type_key.yo convention; FOURTH shell-consumption site. Corpus guard:
  `tests/codegen-bootstrap/recursive_enum_arraylist_sizeof.yo` (pre-fix
  rc=137; guard must NOT call sizeof(MyExpr) directly first — CTFE cache
  priming masks the bug). Write-up:
  `issues/yo-self-recursive-enum-sizeof-zero.md`.
- **DEBUGGING LESSONS:** (1) a crash INSIDE malloc (`mfm_alloc`) = earlier
  heap corruption, and a 0-size allocation is a prime suspect — grep the
  emitted C for `(0ULL) *` BEFORE chasing RC pairing. (2) The crashing binary
  ran FINE under lldb (env/layout sensitivity) — don't trust "works under
  debugger" as evidence. (3) ASan-compiled yo binaries HANG at startup
  (worker-stack interaction, unresolved) — not a usable tool here yet.

## SESSION UPDATE 2026-07-21 (late) — http + ref_field_borrow FLIPPED (#69 +2, 139/183)

- **FRESH-HEAD FULL SWEEP (183 files, not 180): 137 GREEN / 46 RED** before
  this session's fixes; `/tmp/sweep69/results.txt` had the full list. After:
  **139/183**. All gates: codegen-bootstrap diff-test `PASS 135 DIFF 2`
  (both DIFFs — constructor_result_drop, ptr_deref_copy_rc_struct — verified
  PRE-EXISTING with the pre-fix binary), std 153/153, prior-green spot set
  holds (index 48, hash_map 61, algebraic_effects 72, derive 30, …).
- **http.test.yo GREEN (9/9)** — the index-trait element store UAF. THREE
  stacked faithful-port fixes (full write-up:
  `issues/yo-self-index-deref-store-missing-dup.md`):
  1. `evaluator/calls/function.yo` — BOTH index arms now end with
     `attach_temp_variable_to_expr(expr, false, ctx)` (TS function.ts:2810);
     without the temp the RHS has no variable_name and
     `set_expr_as_needs_to_call_dup` no-ops.
  2. `evaluator/utils.yo` `attach_temp_variable_to_expr` — UnknownVal ≠ a
     value for `isCompileTimeOnly: Boolean(value)` (the recurring
     `Some(UnknownVal)`-vs-`undefined` convention gap).
  3. `codegen/exprs/assignment.yo` — port TS assignment.ts:184-199: declare
     the RHS temp FIRST (via get_variable_type_string, the
     declared_c_var_names choke-point), then emit the deferred dup —
     otherwise generate_deferred_dup_expressions' undeclared-temp gate
     silently suppresses the dup. New corpus guard:
     `tests/codegen-bootstrap/index_element_field_store.yo`.
- **ref_field_borrow.test.yo GREEN (11/11)** + ref_return_ban stays green —
  THREE stacked fixes (write-up:
  `issues/yo-self-borrow-gate-module-level-flag-loss.md`):
  1. `evaluator/calls/function_type.yo` — the def-time body-eval env FLATTEN
     loses `is_module_level` (add_variable_to_env can't carry it; TS shares
     Variable objects, function-type.ts:499) → patch it onto the copy.
     LANDMINE: the flatten drops EVERY field the add signature lacks.
  2. `types/flowability.yo` — closure-arg reachability: yo-self never sets
     `closure_function_value` on anon fns (documented Phase-3 convention) →
     fall back to `is_anonymous_function_definition && capture_type.is_some()`
     (TS stamps captureType under the same isCreatingClosure gate).
  3. `evaluator/values/tuple.yo` — `all_known` must read `Some(UnknownVal)`
     elements as NOT known (TS `tupleValues.some(v => !v)`) or a module-level
     tuple with an RC element emits `._0 = /* skip generating value */`.
- **METHODOLOGY:** `check` STOPS at the first failed comptime_expect_error —
  a file with N failing gates surfaces them ONE AT A TIME; each fix exposes
  the next. Don't assume one failure per file.
- **json.test.yo (24/11) is NOT the http root** — `json_parse("[1, 2]")`
  (TWO elements; `[1]` is fine) corrupts the heap in the s1-compiled binary
  (SIGTRAP in a LATER malloc; lldb bt = mfm_alloc). Still red; repro
  `/tmp/json_repro4.yo`; simple recursive-enum push loop does NOT repro —
  needs the recursive parser shape. NEXT: ASan the repro
  (`--sanitize address --allocator libc`) for the first-fault site.

## SESSION UPDATE 2026-07-21 — derive.test.yo FLIPPED (#69 +1, ~133/180)

- **derive.test.yo GREEN (30/30)** via THREE stacked faithful-port fixes, full
  battery + STRICT_FIXPOINT byte-identical, zero regression (corpus 135/2/0,
  std 153/153, all prior flips hold; `tests/impl` red is the pre-existing
  void\* `conflicting types` signature, unchanged). The prior session's
  two-bug model was necessary but incomplete — a THIRD layer was the real
  `.len()` root:
  1. `comptime_fn.yo` `should_cache`: dropped `result_is_comptime_only`
     (TS caches ONLY `isTypeHierarchyType`); the per-variant mapper was
     memoized and every variant got variant 1's Expr.
  2. `function.yo`: `ReceiverMethodResult.receiver_value` captures the
     receiver's concrete value at resolution time; the method-CTFE arm patches
     it into the self ArgEntry (try_to_call binds comptime params to Unknowns
     → `evaluate_comptime_fn_call`'s unknown-arg gate refused to execute).
  3. `type_fns.yo` (the enabler): `map_variants`/`join_fields` bound mapper
     params with `type_of_eval_value(value)` — which has NO ComptimeListVal
     case (→ `unit`), so `variant.fields` lost its ComptimeList type and
     `.len()` dispatched on `unit` (hits=0). Now bind the DECLARED
     `VariantInfo`/`FieldInfo` struct type (TS `value.type` parity).
     Full write-up + probe methodology:
     `issues/fixed/yo-self-derive-mapvariants-mapper-ctfe.md`. LANDMINE: any
     `type_of_eval_value` on a value with ComptimeListVal fields silently
     degrades them to `unit` — thread the declared/evaluated type instead.

## SESSION UPDATE 2026-07-20 (late) — forward_ref_impl_block + flowability_comprehensive + module_struct_unification FLIPPED (#69 +3)

- **module_struct_unification.test.yo GREEN (10/10)** via `2cba96414`, full
  battery + STRICT_FIXPOINT byte-identical, zero regression. A value-struct
  constructor for a struct with a COMPTIME-ONLY field (`tag :: "..."`) emitted a
  field value as a C TYPE NAME ("unexpected type name '\_\_yo_tN'"): the value-struct
  ctor branch (other_fn_call.yo) paired RUNTIME fields (comptime-erased) with
  `runtime_arg_exprs_in_order` (a slot per EVERY field, incl. comptime) BY INDEX,
  so the runtime field got the comptime field's slot (a TypeVal → type name) and
  the real value was dropped. FIX: when the counts disagree, re-derive via
  `_ctor_args_from_labeled` (match runtime field → labeled ctor arg by name) — the
  matcher the object-ctor path already used. Full write-up:
  `issues/yo-self-comptime-field-struct-ctor.md`. LESSON: `runtime_arg_exprs_in_order`
  is NOT runtime-field-aligned when a struct has comptime-only fields — match by
  field/label, never by raw index.

- **flowability_comprehensive.test.yo GREEN (3/3)** via `e3622aa57`, full battery +
  STRICT_FIXPOINT byte-identical, zero regression. A TWO-gap str/ArrayList
  range-window slice chain, cracked by stacking two codegen fixes:
  (Gap 2, evaluator) the operator-CTFE set `runtime_arg_exprs_in_order`
  UNCONDITIONALLY, so a comptime-folded STRUCT/ENUM operator result (a constant
  `Range` from `usize(6)..usize(11)`) looked like a runtime CONSTRUCTOR
  (`is_runtime_ctor`) and skipped generate_comptime_value → "// Failed to
  transpile"; gate it to the runtime case so folded operators take the
  concrete-value short-cut. (Gap 1, codegen) `v(range)` is rewritten to
  `v.slice_copy(range)` reusing the call id + recording the method-callee, but
  collection AND emission gated that lookup on a DOT callee (the source callee is
  the bare `v`); hoist collection out of the dot block + add a non-dot
  value-call emission branch (same family as forward_ref). Full write-up:
  `issues/yo-self-str-range-slice-codegen.md`. LESSON: a comptime-folded operator
  returning a struct/enum must NOT carry runtime_arg_exprs; and the method-callee
  side-table must be consulted for non-dot value-calls, not just dot methods.

- **forward_ref_impl_block.test.yo GREEN (5/5)** via `12c3109ff`, full battery +
  STRICT_FIXPOINT byte-identical, zero regression. ONE-LINE codegen fix
  (`collection.yo`): deref a POINTER receiver to its pointee before the
  method-call registry lookup. Root: yo-self models a forward-ref/recursive impl
  method as a THUNK (`register_shell_redirect` + generation.yo thunk), NOT TS's
  in-place shell merge; the thunk's real func must be collected separately, but
  `type_id_or_empty` has NO Pointer case → returns "" for `self : *(Self)`,
  skipping the registry lookup that's the ONLY collection path for a method
  called EXCLUSIVELY via forward-ref. Value-receiver forward refs already worked.
  Full write-up: `issues/yo-self-forward-ref-impl-pointer-receiver-uncollected.md`.
  **GENERAL landmine: `type_id_or_empty` silently returns "" for Pointer (and any
  compound type) — any registry-keyed dispatch/collection on a pointer receiver
  no-ops.**

- **FRESH GROUND-TRUTH RE-SWEEP (s2 = HEAD+fix, /tmp/s2fri).** Confirmed the
  tractable single-root flips are EXHAUSTED — forward_ref_impl_block was the last
  one in the current batch. Every other red file is deep multi-error Gap-6:

  - **P3 per-call type identity (~12 — THE dominant lever):** arc, thread, worker
    (`passing/assigning '__yo_tN'` mismatch), collections/linked*list (8 errs,
    `__yo_t23`≠`__yo_t33`≠`__yo_t35` for one logical type), imm_list, imm_string
    (`initializing '__yo_tN'`), sync/\* + imm_map + ordered_map (15-21 errs each;
    `call to undeclared function 'yo_id*..**unknown**Type\_\_..rtparam..'`— the
specialized name carries an UNRESOLVED type). type_key.yo ALREADY dedups
structs aggressively (cfid+type_args + structural fallback +`!AMBIG` poison);
    the divergence is UPSTREAM — create_specialized feeds structurally-divergent
    struct instances for one logical type. Codegen cannot fix it soundly → P3.
  - **Deep behavioral Gap-6 (compile-green, 1-2 runtime fails):** cycle_collector
    15/16 ("Garbage cycle collected while live objects survive" — GC trace/dispose
    correctness), sys/timer ("Test Io timer" — async), http/http 7/9. Gap-6 at
    runtime = same P3 root manifesting as wrong behavior, not a compile crash.
  - **Other specific-but-multi-root:** sys/bufio (16× `no member` — async struct
    type), flowability_comprehensive (unexpected-type-name + undeclared),
    closure_capture_rc_leak (11× undeclared), impl (`conflicting types` void\*),
    derive/derive_clone_complex, module_struct_unification.

- **NEXT ARC = P3 (`create_specialized_function_inline`).** Unblocks ~12 files at
  once. Highest lever, highest risk (broke stage2 fixpoint 6× at self-compile
  scale; salvage plan on branch `wip/resolution-time-spec`). Deserves a dedicated,
  fully-gated session — NOT a context-tail rush. Cheap extra gate for all spec
  work: build stage2 + `s2 check std/env.yo` before any sweep.

## SESSION UPDATE 2026-07-20 (evening) — comptime.test.yo + error.test.yo FLIPPED (#69 +2)

- **error.test.yo GREEN (8/8, matches TS)** via two faithful fixes, full-battery
  validated + STRICT*FIXPOINT byte-identical: `24a165d9f` (downcast to a
  VALUE/newtype target extracts from the Box `((Box\*)dyn.data)->\_u42*`+ dup —
the`wasBoxed`branch the file header wrongly called unreachable; yo-self DOES
box value types into dyns) +`0e6dca6ea`(type_key: an EMPTY-id enum
—`create_option_type`'s synthesized `Option`, id="" — was keyed by NAME
via `type_to_string`, collapsing every `Option(T)`to one C type; now keyed
structurally so`Option(String)`≠`Option(MathError)`). LESSON: an empty-id
synthetic enum needs the structural-sig key, not the name-only shortcut. Full
breakdown in `issues/yo-self-downcast-value-type.md`.

- **comptime.test.yo GREEN (28/28, matches TS)** via THREE stacked faithful
  fixes, each full-battery-validated + STRICT_FIXPOINT byte-identical:
  `dbe5b4f77` (generate_return: void\* return-temp → fn return type),
  `660f98312` (per-param comptime modifier port: runtime `Negate` overload arg
  conversion, replacing the unfaithful `!is_some_type` proxy with TS's
  `!parameter.isCompileTimeOnly`), `d43fb4a73` (should_skip drops a spec whose
  RESOLVED RESULT is comptime_int/float/string — the dead `comptime_neg`
  overload spec). A 4-layer multi-error file cracked end-to-end — **proof a
  multi-error Gap-6 file flips by stacking targeted faithful fixes.** Full
  breakdown + the probe cascade ([RICO]/[SKIPCF]/[CVT], emit-c-only, that
  cracked the `Call :: (neg, comptime_neg)` overload func_id/type threading) in
  `issues/yo-self-return-temp-void-someT.md`. LESSON: the operator func_id is
  SHARED across runtime+comptime specs — no per-func_id comptime flag; the
  per-call resolved RESULT type is the reliable comptime signal.

## SESSION UPDATE 2026-07-20 — READ FIRST

- **#69 now ~131/180.** Flips this session (all gated: corpus 135/2/0, std 153/153,
  STRICT_FIXPOINT=HOLDS, prior flips hold): `\u` decode (str 3/3), FloatLit exponent
  (duration 12/12), **ref_return_ban 2/2** (`cfc76fcf1`, call-time is_ref),
  **forward_ref_self_method 2/2** (`473ddb78b`, static Self.method collection),
  **iso_api_surface 2/2** (`ec1e99822`, tid-less method dispatch). Plus iso port
  layers 1–3a (`83af97e4e`/`294d6b6e1`/`dadabe775`) and the determinism/fixpoint fix
  (`ebdd27ca8`). User directive: **ALWAYS build --release (-O2), never -O0.**

### CONTINUATION 2026-07-20 (later session) — accurate re-triage, 2 attempts reverted

- **⚠️ METHODOLOGY (cost me ~1h): REBUILD `/tmp/s1rel` from HEAD before ANY sweep.**
  A stale `s1rel` (predating this session's 5 commits) reported iso_api_surface /
  forward_ref_self_method as RED (false failures). Rebuild:
  `./yo-cli compile yo-self/main.yo --release -o /tmp/s1rel` (~1.6 min). Then the 3
  flips + time/duration all verify GREEN (**#69 is ~132, not 131** — time/duration
  already flipped via the FloatLit workaround). Sweep with the fresh binary; the old
  `clusters.md` was stale.
- **ACCURATE current red clusters (fresh-binary sweep, 36 files):**
  - _async-future_ (7): fs/{dir,file,temp,metadata,walker,fs*convenience}, sys/bufio —
    `no member __yo_resume_fn in struct __yo_io_future_t`. **CONFIRMED Gap-6** (not a
    tractable classification fix). Attempted `is_io_future || future_type_name ==
    "\_\_yo_io_future_t*"`at await.yo:437 — peeled the resume_fn layer but exposed the
    REAL root:`**sync_future->result`is`int32_t`(generic io-future field) where the
    result type is specific. These are STATE-MACHINE futures whose SomeT
   `resolved_concrete`isn't populated → get_type_string falls back to generic
   `**yo_io_future_t*`instead of the specialized`*...\_sync_fut_t\*`. TS reads
`resolvedConcreteType`(await.ts:82-95; isIoFutureType branch-1). REVERTED — the fix
is resolved-concrete population, the Gap-6 core.`is_io_future_type` branch-1 gap
    (state_machine.yo:42-48) is a downstream symptom, not the root.
  - _dispose_ (6): ordered_map, sync/{channel,mutex,once,rwlock,waitgroup} —
    `undeclared yo_id_N` (collectDisposeMethodsFromGenericImpls). Gap-6-blocked.
  - _spec-identity Gap-6_: impl, arc, error, cli/arg_parser, linked_list,
    impl_fn_field_rejection, ref_closure_capture, derive_clone_complex.
  - _type-name-as-value_: module_struct_unification (`.next = __yo_t32`), flowability
    (`__yo_str w` cascade — see below), iso 3c (`__yo_t29.can_isolate`).
  - _behavioral_ (compile-green, some tests fail): json (24/35), http (7/9),
    dyn (5/8), cycle_collector (15/16), sys/timer.
- **flowability_comprehensive — PRECISELY diagnosed, faithful fix is a hot-path change:**
  root is `v(a..b)` (String/str range-slice) emitting `// Failed to transpile v(a..b)`
  (the FTT comment eats the `;` → cascade of "unexpected type name" errors). The eval
  rewrite `_try_rewrite_range_index_to_slice_copy` (function.yo:757) EXISTS, IS reached,
  and finds `slice_copy` (probe: found=1) — it rewrites `v(a..b)` → `v.slice_copy(a..b)`
  and records a macro_expansion. **But codegen still FTTs** because of a NODE-IDENTITY
  mismatch: the eval instance the rewrite fires on and the AST node codegen walks have
  DIFFERENT ids (probe: record id 56261 vs codegen lookup id 56259, a consistent +2
  offset). TS mutates `expr.func` IN PLACE (function.ts:833); yo-self's `AstExpr` is a
  `ref(enum)` whose variant fields can't be reassigned (no in-place AST mutation exists
  anywhere in yo-self — all rewrites go through `record_macro_expansion` keyed by id),
  so the side-table lookup misses when the two instances' ids diverge. The rewrite is
  also only wired into 2 evaluate_function_call arms (function.yo:3672/3996); TS runs it
  PRE-DISPATCH (function.ts:768, + a `recvHasComptimeSliceValue` guard yo-self omits).
  Faithful fix candidates: (a) hoist the rewrite pre-dispatch AND port the comptime
  guard, OR (b) eliminate the intermediate AST clone so eval/codegen ids align. Both are
  hot-path eval changes with fixpoint risk — NOT an end-of-session change. ~1 file
  direct; `..` appears in ~11 test files (index/array/for_macro_borrow/async_await/…).
- **float formatter faithfulness (latent):** yo-self's FloatLit raw comes from f64
  `.to_string()` = C `%g` (std/fmt/to_string.yo:139,151) → `1e+09` for large magnitudes
  and DEFAULT-6-SIG-DIGIT PRECISION LOSS; TS uses JS `Number.toString()` (`1000000000`,
  full precision). The e/E workaround (comptime_value.yo:191-193) only prevents invalid
  C (`1e+09.0`), not the divergence/precision loss. time/duration passes (low-precision
  literals); a high-precision float literal in a test would fail at runtime. Fix =
  round-trippable decimal formatting; flips 0 files today (deferred, documented).
- **⚠️ ASSESSMENT CORRECTION (important): the "~26 Gap-6 files" count is OVERSTATED.**
  iso L3b looked like Gap-6 (per-call return-spec) but PROBING it revealed a tractable
  **dispatch gate** (`other_fn_call.yo:997` gated on `tid.len()>0`; Iso has no registry
  type-id, so the expr-id-keyed side-table lookup was wrongly skipped — `ec1e99822`).
  LESSON: **PROBE each "Gap-6" file before assuming it's blocked** — several may be
  dispatch/collection gaps in disguise (has_ei=true + FTT via the general path ⇒ a
  dispatch gap, not Gap-6). Probe technique: eprintln at the FTT branches +
  `lookup_method_callee_value`/`get_type_trait_methods_by_name`/`type_id_or_empty`.
- **RED-FILE SWEEP categorization (2026-07-20, under s2disp — triage by error
  signature to apply the probe-don't-assume lesson):**
  - _true Gap-6_ (`incompatible type __yo_tX` / `initializing __yo_tX with __yo_tY`):
    arc, error, cli/arg_parser, imm_list (and by pattern imm_map/set/string,
    collections/\*, thread) — per-call type identity, the genuinely HARD core.
  - _collection gaps_ (`undeclared yo_id_N`): sync/mutex (`yo_id_6143` = the
    `dispose_fn` — the generic user-dispose from `find_methods_from_generic_impls`
    is NOT specialized+collected the way `trace` is via
    `_specialize_and_register_trace`; yo-self relies on a lazy `self.dispose()` call
    in `_synthesize_and_register_dispose` that doesn't reach it — INTRICATE, but a
    port not Gap-6; ~7 dispose files share it), closure_capture_rc_leak
    (`yo_id_2938__unknown__Type`).
  - _type-name-as-value codegen_: module_struct_unification (`__yo_t32` closure-fn
    field), derive (`...#(match_branches)` macro splice).
  - _other_: dyn (rc=1, **5 passed / 3 failed** — the 3 fails are box/Box(T) dynamic
    dispatch at RUNTIME, not a compile error — deeper); derive*clone_complex — NOT a
    simple unit-field: the C has `__yo_t54` = `Box(unit)` (`void \_u42*`) yet the
  ACCESS sites do `obj->_u42_.tag`/`.data.Branch`(a Box(TreeEnum)) — i.e. a Box
  **type-identity collision** (Box(unit) & Box(enum) both → __yo_t54) = Gap-6, not
  a unit-field exclusion; ref_field_borrow (borrow-check not enforced in eval).
⇒ PROBE CONCLUSION: after iso L3b (the tractable exception, fixed), the remaining
  probed candidates (dyn runtime, derive_clone_complex Box-collision, dispose
  id-consistency, spec-identity incompatible-type) are ALL Gap-6/type-identity or
  intricate — no more one-shot dispatch/gate wins. The hard core is genuine.
  ⇒ The spec-identity cluster IS largely true Gap-6; the biggest tractable leverage
  is the dispose family (~7 files, one collectDisposeMethodsFromGenericImpls-style
  specialize+register port, mirroring`\_specialize_and_register_trace`).
- **DISPOSE FAMILY refined (~7 files, biggest leverage — NOT a mirror-trace port):**
  `get_dispose_function_for_type` (drop_dup.yo:60) already keys by `type_key` +
  `"___dispose"` (like trace), and `collect_dispose_methods` (codegen_c.yo:245) DOES
  run `_synthesize_and_register_dispose` for every RC struct incl. Mutex, and
  `_eval_and_register_rc_method` both registers the trait method AND
  `base.register_function` + `find_function_calls`. YET Mutex's \_\_\_dispose
  (`yo_id_6143`) is FOUND by get_dispose_function_for_type but is NOT in
  base.functions (undeclared). So the synthesis→register→collect chain has a subtle
  gap for Mutex — likely fid churn between synthesis and codegen, OR the synthesis
  soft-fails mid-body (fv_opt None) yet a stale registry entry survives. NEXT-SESSION
  PROBE: eprintln in `_eval_and_register_rc_method` (did it run for Mutex? what fid?
  did register_function fire?) + compare the fid to the constructor's referenced id.
  A dedicated arc, not one-shot.
  **PROBE RAN (2026-07-20): dispose family is Gap-6-BLOCKED, NOT a clean flip.** The
  probe showed `_eval_and_register_rc_method` DOES run for Mutex, synthesizes the
  **\_dispose (fv=FuncVal), and register_function DOES fire (`fid=yo_id_6143 had=false`)
  — collect_dispose_methods (codegen_c.yo:245) runs before generate_all_functions
  (274), so it's registered in time. Yet yo_id_6143 is still undeclared at use, AND
  sync/mutex ALSO has spec-identity errors on top:
  `yo_id_5024**unknown**Type**…R*gs*…`(a specialized method with UNRESOLVED types),`yo_id_4992`undeclared,`expected expression`. So the dispose files are
  MULTI-ERROR (dispose-emission + Gap-6 spec-identity) — fixing dispose alone won't
  flip them. This retracts the earlier "biggest tractable leverage" claim: the
  dispose family is genuinely Gap-6-blocked, as the original round-19 note said.
- Remaining iso: iso.test layer 3c (`^` op `(temp_type <: Isolation).can_isolate(x)`
  emits `Type.can_isolate` type-name-as-value — a static-trait-method dispatch,
  prelude.yo:7461); rc layer 4 (`Array_Array_*` nested-array decl, not collected —
  collect_types_from_expr skips BK_TEST at collection.yo:578). Both NOT Gap-6. See
  `issues/yo-self-iso-runtime-port.md`.
- **FIXPOINT: FRAGILITY FIXED (`ebdd27ca8`).** The strict stage2≡stage3 gate is
  the s1(TS) vs s2(self) 3-stage comparison; it was marginally host-dependent
  (HashMap bucket-order emission — a fresh clean rebuild broke it, though the
  committed compiler was self-stable). The **determinism fix LANDED**: function
  emission now iterates a `function_order` insertion-order list (mirrors TS
  `for..in`) instead of `functions.keys()` bucket order. Result:
  **STRICT_FIXPOINT=HOLDS robustly**, regression-free (corpus PASS 135, std
  153/153, prior flips hold). The function half ALONE sufficed (type_order NOT
  needed — spec/type ids are assigned during now-deterministic function
  emission). Bootstrap fixpoint is now robust; future function-adding fixes
  won't destabilize it. (`issues/yo-self-emission-order-nondeterminism.md` has
  the full analysis.)
- **Full clustering of the 52 remaining red files (this session's sweeps,
  s2_r19pin/s2_p1d):**
  - _Spec type-identity_ (~14): `incompatible type __yo_tX vs __yo_tY` /
    undeclared `yo_id_N`/`**unknown**Type`/`gs_` specs — arc, imm_list/map/set/
    string, thread, error, impl, cli/arg_parser, collections/linked_list/
    ordered_map, closure_capture_rc_leak, forward_ref_self_method. Per-call
    type identity (Gap-6 family). HARD.
  - _"expected expression" codegen_ (~5): derive, dyn, flowability_comprehensive,
    forward_ref_impl_block, module_struct_unification. Emitter puts a type name
    where C wants a value (msu: `.next = __yo_t32` — closure/fn-typed struct
    field emits the struct type name). LIKELY MULTIPLE ROOTS (diverse features).
  - _Async-future_ (5): fs/dir/file/fs*convenience/walker, sys/bufio —
    forward-decl emits `\_\_yo_io_future_t*`but def emits`\*...\_sync_fut_t\*`
    ("conflicting types"). The io.async block's SM struct name (ei.
    async_state_machine_struct_name) is computed during BODY emission, too late
    for the decl phase (699/725). Needs a pre-pass. Async-arc.
  - _Dispose_ (6): sync/atomic/channel/mutex/once/rwlock/waitgroup +
    ordered_map — `undeclared yo_id_N` (Mutex=6143). collectDisposeMethods-
    FromGenericImpls, Gap-6-blocked (ledger item 8).
  - _incomplete-void_ (2): derive_clone_complex, worker (`incomplete type void`).
  - _check-error_ (2): ref_field_borrow, ref_return_ban — `Expected compile
error but evaluated successfully` (borrow check not enforced in yo-self eval).
  - _Iso port_ (3): iso, rc, iso_api_surface — get_type_string .IsoT panic +
    generate_iso_type_declarations is a NO-OP stub (P4). IN PROGRESS.
  - _behavioral_: cycle_collector (15/1 — "Garbage cycle collected while live
    objects survive"), encoding/json (24/11), http/http (7/2), sys/timer (1 —
    io.async FSM transform, dedicated arc).
  - TIMEOUT (5): collections/btree_map/priority_queue, imm_sorted_map/set,
    imm_threading — exponential re-eval (spec family).
- Scratchpad: `clusters.md`, `red_root.txt`/`red_subdir.txt`, `diag_sweep.sh`,
  `gates_p1d.sh` (functional gate template — macOS has no `setsid`, use
  `timeout -s KILL` alone).
- **Scoped roots (this session's deep-dives — start here for these files):**
  - `ref_return_ban` (1 file): **BOTH LAYERS FIXED — file GREEN (2/2).** LAYER 1
    (`e746531c2`): the trait-method `-> inout(Self.Element)` ban was swallowed
    because `_evaluate_trait_field` (trait.yo:771) evaluated the field TYPE via
    the non-raw (swallowing) `evaluate_expression`, unlike its sibling paths
    (313/458) which use `evaluate_expression_raw`. Now uses raw + passes exn →
    the ban propagates to `comptime_expect_error`. LAYER 2 (real root — NOT the
    "plain field-access emitter" earlier guessed): the specialized `with_x`
    emitted `p.x` on a pointer param (`__yo_tN* p`) instead of `(*p).x`. Root:
    the **call-time runtime param binding** at `function.yo:3239` bound params
    via `add_variable_to_env`, which HARDCODES `is_ref=false` (env.yo:836) — the
    computed `p_is_ref` only set `is_reassignable`, so codegen's `_var_read_code`
    (atom.yo:118) saw `is_ref=false` and skipped the deref. The def-time body
    eval binds via `add_parameter_to_env` (function_type.yo:362, sets is_ref) —
    which is why the NON-specialized copy was correct. FIX: bind via
    `add_parameter_to_env` with `is_ref=p_is_ref, is_parameter=true` (mirrors TS
    helper.ts:584). Method/index-trait calls all route through this same site, so
    one fix covers the call-time path. Probe technique that found it:
    `_var_read_code` eprintln of `is_ref`/`nvars` for the failing var (`is_ref=false
nvars=1` in the spec fn vs `true` in the original) → nvars=1 ruled out the
    rebind loop, pointing to the initial binding. See
    `issues/yo-self-spec-inout-isref-dropped.md`. This is is_ref (deref), NOT
    Gap-6 — most remaining spec files are still Gap-6.
  - `forward_ref_self_method` (1 file): **FIXED — GREEN (2/2).** A forward-ref
    static `Self.callee` (caller before callee in the impl) emitted `yo_id_N(n)`
    with NO definition ("call to undeclared function"). The collection walker
    (`find_function_calls_in_expr`, collection.yo ~504) resolves a method call via
    the type-trait-methods registry keyed by `type_id_or_empty(recv_ty)` — but a
    STATIC receiver evaluates to a TypeValue, so `recv_ty` is the metatype `Type`,
    not `P`, and the lookup missed P's static methods. FIX: derive `ctid` from the
    receiver's `TypeVal` wrapped type (falling back to `recv_ty`); mirrors TS
    `isTypeValue(value) → collectType` (collection.ts:615). Additive, TypeVal-only.
    See `issues/yo-self-forward-ref-static-method-collection.md`. NOT Gap-6.
  - `module_struct_unification` + the "expected expression" cluster: NOT one
    root (CONFIRMED multiple). msu emits a closure/fn-typed struct field as the
    struct TYPE name (`(__yo_t32){ .next = __yo_t32 }` for `Counter(next : (() ->
i32(7)))`). **CORRECTION (2026-07-20 evening): this is CONTEXT-SPECIFIC, NOT a
    general closure-field codegen bug.** A minimal standalone repro
    (`make_counter :: (fn() -> Counter)(Counter(next : (() -> i32(7))))`) emits
    CORRECTLY in BOTH TS and s2 (`.next = fn_yo_id_N`, a real fn pointer). The
    `.next = __yo_t32` bug only appears in the FULL test's batch/test-block +
    `while`-loop + `Box(i32)` context (the failing test is "given(struct) inside
    a while-loop"). So the closure-field emitter is fine; the bug is a
    context interaction (closure construction inside a loop body / batch main).
    Next session: reproduce via `YO_KEEP_BATCH=1` (the batch main), not a
    standalone `fn`, and diff the closure arg's ExprInfo in-loop vs isolated. iso.test's "expected
    expression" is a DIFFERENT root (FTT of `.extract()` — see iso patch commit
    90fd8ece1). **`derive` root (found this session):** derived enum-`Eq` emits
    `return // Failed to transpile match(self, ...#(match_branches), ...);` — the
    derived match's arms are an UNEXPANDED macro splice `...#(match_branches)`
    (appears 3x, one per variant group). Codegen FTTs the whole match into a `//`
    comment, so `return ` has no expr → "expected expression". No `...#` splice
    handling exists in yo-self codegen (grep-empty) and `match_branches` is not in
    source (macro-generated), so the splice must be expanded during derive EVAL
    and isn't — a macro-expansion gap (cf. [[recur codegen]] side-table). Deep;
    likely shared with `dyn` (also derived-match). A multi-cycle macro arc, not a
    quick flip.
  - `iso`/`rc`/`iso_api_surface` (3 files): **LAYERS 1+2 DONE this session; layers
    3-4 remain (see `issues/yo-self-iso-runtime-port.md`).** L1: get*type_string
    `.IsoT` arm (name+registration). L2: `generate_iso_type_declarations` full
    runtime port (struct + create/extract/dispose decls & impls + IsoTypeInfo
    flags) — all 3 files now compile past the struct-decl layer. \*\*L3 (`.extract()`
    call-site FTT — iso, iso_api_surface; likely eval Option(T)-vs-Phase-H-T
    mismatch) + L4 (`Array_Array**` nested-array decl — rc) remain.\*\* The stale
    text below is superseded by the issue doc. —
    get*type\*string's `.IsoT` arm was a panic stub; ported it (name build +
    `iso_types` registration, mirrors TS getTypeString Iso case). iso.test now
    advances past the panic to `unknown type 'Iso\**'`/ undeclared`\__yo_create_iso_\_`. **LAYER 2/3 OPEN:** `generate_iso_type_declarations`(generation.yo:1097) is still a NO-OP stub — port the full 176-line TS`generateIsoTypeDeclarations`(generation.ts:1047): Iso struct + create/extract/
    dispose decls & impls. All deps EXIST (needs*cycle_gc, dispose_type_ids,
    *\_\_drop registry lookup, register\*iso_type). Mechanical template translation.
    \*\*Complete spec in`issues/yo-self-iso-runtime-port.md`.\** (Supersedes the
    earlier ".extract()/Array*Array\*\_ decl" guess.) PORT work, NOT Gap-6.
  - **async-future cluster (5 files — best files/cycle) PRECISE scoping:** SM
    struct name = `` `${async_block_id}_state_t` `` where async*block_id =
    `ei.variable_name` (async.yo ~1490/1914), set via `_set_async_sm_struct_name`
    (async.yo:1864 → `ei.async_state_machine_struct_name`). Forward-decl reads it
    at declarations.yo:520 (`_async_override_return_type`) but finds `.None` →
    `\_\_yo_io_future_t*`fallback (the`.None` branch, NOT a wrong name) →
"conflicting types" vs the def. CRUCIAL: the pre-pass
(`preregister_async_blocks_in_expr`, async.yo:1893, called via
`preregister_async_block_types`at codegen_c.yo:265 BEFORE declarations)
ALREADY computes`${async_block_id}\_state_t`and calls`\_set_async_sm_struct_name`(async.yo:1914-1915) — yet the forward-decl reads`.None`. So the bug is NOT "missing pre-pass"; it is either (a) the setting is
LOST — the async-block ExprInfo is REPLACED between the pre-pass and the decl
phase (the ExprInfo-table store-without-dup / UAF class — the pre-pass mutates
`ei`then`expr_info_table_set`s it, but a later eval/collect pass overwrites
the table entry), or (b) the async-block condition at async.yo:1897 is not met
for the fs/* `File.open`-delegate shape (so the pre-pass never sets it). PROBE
(one debug build): at declarations.yo:520 print `ei.async_state_machine_struct_name`    -`ast_expr_id`, and at async.yo:1915 print the same id + name — compare ids to
    see if it's a different ExprInfo (→ persistence fix) or never-set (→ path fix).
  - **async-future is likely the DELEGATE case** (declarations.yo:690-696
    comment): fs/\* `File.open` RETURNS `File.open_with(...)`'s future (no direct
    async block of its own), so the forward-decl's `find_returned_async_block`
    returns `.None`. The 2-round `_async_override_return_type` loop (699) is meant
    to resolve callee-before-caller, but iterates `functions.keys()` in HASHMAP
    order → if `File.open` sorts before `File.open_with`, round 1 can't resolve
    and 2 rounds don't cover deeper/misordered chains. **CROSS-CLUSTER LINK:**
    making the 699 loop iterate INSERTION order (callee registered before caller)
    is exactly the determinism fix's declarations.yo:699 change. **OUTCOME
    (`ebdd27ca8`):** the determinism fix DID advance all 5 fs/_ files —
    forward-decl "conflicting types" is GONE. NEXT LAYER (now the only fs/_
    blocker): the AWAIT site `future_type_name := get_type_string(future_type)`
    (await.yo:378) still returns the generic `__yo_io_future_t*` fallback, but
    the poll loop (await.yo:439) accesses the SPECIFIC SM field `->__yo_resume_fn`
    → "no member named **yo_resume_fn in struct **yo_io_future_t". FIX: at the
    await site, resolve `future_type` (a Future SomeType) to its concrete SM
    struct — TS reads the per-call SomeT's `resolvedConcreteType` (await.ts:82-95);
    yo-self lacks that (Gap-6). Lead: read the awaited future's async block's
    `async_state_machine_struct_name` (as the forward-decl now does), or register
    `type_key(future_type) → SM struct` so get_type_string resolves it. Fixes 5
    files.
  - Determinism (host-independent fixpoint): **LANDED `ebdd27ca8`** —
    STRICT_FIXPOINT=HOLDS robustly with the function_order half alone. Bootstrap
    fixpoint no longer fragile.

## TL;DR — where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61** files match the TS baseline.
- **#69 (`s2 test ./tests`): 128/180** files match. 52 remain; see SESSION
  UPDATE above for the full current clustering (supersedes the round-19 red list
  at the bottom for triage purposes).
- ~32 gated fix commits landed across the campaign.

## Definitions

- **s1** = the TS-compiled yo-self binary: `./yo-cli compile yo-self/main.yo --release -o /tmp/s1`.
- **s2** = clang -O2 of the C that s1 emits for yo-self itself (stage2.c).
- **fixpoint** = stage2.c ≡ stage3.c byte-identical (s2 re-emitting yo-self).
- **#69 / #70** = self-hosted test runner parity on `./tests` (180 files) /
  `./yo-self/tests` (61 files) vs `./yo-cli test`.
- A test FILE "matches" when `s2 test <file>` rc==0 with the same pass count
  as `./yo-cli test <file>`.

## THE METHOD (non-negotiable — proven over ~25 fix rounds)

1. **Faithful port first.** Find the TS behavior (file:line), port that shape.
   When yo-self's model genuinely differs (value semantics vs TS object
   identity, mutable env vs persistent chains), document the divergence in a
   comment AND pick the semantically equivalent mechanism — see
   `_freshen_io_builtin_callee` (calls/function.yo) and the Step-2 skip
   (calls/helper.yo) for worked examples.
2. **Full gate battery after EVERY yo-self change; revert on ANY regression.**
   Copy `scratchpad/gates_v18.sh`-style scripts (sed-rename the binary/temp
   names per iteration). The battery: corpus diff-test → `check ./std` →
   5-repro battery → SAME-BINARY DOUBLE-EMIT determinism → stage2 clang →
   `s2 check std/env.yo` → stage3 emit → fixpoint cmp → target/flip files.
   Green baseline: `PASS 135 DIFF 2 SELF-FAIL 0`, `STD_RC=0`, all `BATTERY
compile=0 run=0`, `S1E_DETERMINISTIC`, `ENV=0`, `FIXPOINT=HOLDS`, flips
   install_command 43 / effect_analysis 19 / lexer 34 / phase6_verify 3 +
   targets cache 6 / suspension_analysis 9.
3. **Probe before fixing.** Debug builds with `eprintln` instrumentation
   (~8-10 min per `./yo-cli compile yo-self/main.yo --release` cycle) beat
   speculation. Strip ALL instrumentation before the gate build (git checkout
   for pure-debug files; the commit must match the gated tree).
4. **Batch shape matters.** The runner synthesizes
   `main :: fn() -> unit { io :: __yo_builtin_io; match(env YO_TEST_INDEX) …cond arms… }`
   per ~30 tests. Many bugs ONLY reproduce there. `YO_KEEP_BATCH=1 s2 test <file>`
   keeps `<dir>/.yo_selftest_batch_N.yo` + `.bin.c`. **Batches REGENERATE per
   run — never correlate line/col positions across runs** (this misled two
   probe cycles; same-run data only).
5. **Sweeps**: pin binaries (`cp /tmp/s2vN /tmp/s2_rNpin`), python runner with
   `preexec_fn=os.setsid`, 600s timeout, `.done` files for resumability
   (`scratchpad/s2_sweep_r19.py` is the template; the 74-file divergent list
   is `/tmp/s2_r4_list.txt` — regenerate from the red list below if lost).
   Long jobs die on this machine — `nohup … & disown` + Monitor loops, never
   foreground sleeps. Don't cp over a running binary (SIGKILL). Sweep
   timeouts ≈ 10× the TS per-file time; a big overshoot IS the divergence.
6. Known noise: corpus `DIFF 2` (bench_sort timing + ptr_deref_copy_rc_struct
   RC-count print) is the accepted baseline. rc=139 right after a C-compile
   failure is the known teardown segv, not a new crash. Don't run
   `check ./yo-self` whole-dir as a gate (known ~50-min stall).

## BUILD / VERIFY COMMANDS

```bash
bun run build                                    # always before yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1   # s1 (~8-10 min)
/tmp/s1 compile yo-self/main.yo --emit-c -o /tmp/stage2 # stage2.c (~10 min)
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
/tmp/s2 test ./tests/<file>                      # the #69 definition
YO_SELF_BIN=/tmp/s1 scripts/diff-test.sh tests/codegen-bootstrap --parallel 4
YO_MAIN_STACK_MB=4096 <bin> …                    # for deep-recursion checks
./yo-cli check yo-self/<file>.yo                 # fast type-check iteration
./yo-cli fmt yo-self/<file>.yo                   # REQUIRED before commit
```

## REMAINING #69 WORK — priorities, in detail

The 54 red files (round 19): 46 rc=1, 5 TIMEOUT, 3 rc=-6. Full list at the
bottom. Work them in this order:

### P1 — `\u` escape decode gap (quick win, 1-2 file flips)

`tests/str.test.yo` fails ONE assert: `String.from("café").raw_bytes().len == 5`
(the `é` source form). TS decodes escapes at parse (JSON.parse — the
stored value holds the real 2-byte é); yo-self's `StrLit` keeps RAW token
text and decodes at consumption — its decoder handles `\n/\t/\"/\\` (proven
by the suite) but NOT `\uXXXX`; `_c_string_literal`
(codegen/exprs/comptime_value.yo) then escapes the backslash and the C
string is the literal 9 bytes. FIX: find the shared escape decoder (grep the
`u8(92)` handling that also handles `n` — start at
`yo-self/evaluator/values/string.yo`, whose header describes the
decode-at-evaluation convention, and `yo-self/evaluator/values/char.yo:33`
which decodes char escapes) and add `\uXXXX` → UTF-8 encoding wherever the
basics are decoded (there may be more than one consumer — eval-side String
construction AND `_c_string_literal`'s C-literal rendering; TS reference:
whatever `src/lexer.ts`/JSON.parse produce, then
`comptime-value.ts:82 JSON.stringify`). Check `tests/encoding/json.test.yo`
for the same root. Verify: str + json files, then full gates.

### P2 — the behavioral single-failure tail (compile-green files)

Files that COMPILE and run with few failing tests — cheapest per-file wins.
Diagnose with `s2 test <file>` and read the failing assert. Untriaged
candidates: cycle*collector, time/duration, sync/atomic, sync/rwlock,
comptime, error, impl, module_struct_unification, ref*_ trio,
flowability*comprehensive, forward_ref*_ pair.

EXCEPTION — do NOT treat as quick wins:

- `tests/sys/timer.test.yo` (1 failure): cooperative-interleaving semantics —
  yo-self lowers awaits inside io.async closures as BLOCKING sync-await poll
  loops; TS transforms multi-await closures into resumable FSMs
  (`_yo…_resume` switch). The fix is the io.async closure FSM transform port
  (codegen/async/) — a dedicated arc.

### P3 — Gap-6: `create_specialized_function_inline` (the dominant blocker)

Blocks three sub-families:

- The `imm_*` family + linked*list/ordered_map/priority_queue (the
  `yo_id*…**unknown**Type…` undeclared-spec class — uncollected/
  mis-specialized generic-impl methods).
- The generic-impl DISPOSE family (`tests/sync/*` + imm_map + ordered_map):
  `collectDisposeMethodsFromGenericImpls` (TS collection.ts:650) was never
  ported. The port is NOT the direct-registration TS shape — yo-self's
  `find_methods_from_generic_impls` returns a GENERIC (hard-generic,
  emission-skipped) FuncVal, so the constructor's `header.dispose_fn = <fid>`
  renders an undeclared identifier (e.g. Mutex's `yo_id_6143`). The full
  three-stage fix (trace-sibling-shaped monomorphizer via
  create_specialized_function_inline + emittable-entry resolver preference in
  `get_dispose_function_for_type`) is DESIGNED AND PRESERVED in ledger item 8
  — it lands trivially once the monomorphizer handles those bodies (currently
  it soft-fails on them — the Gap-6 class).
- Most of the 5 TIMEOUT stalls (imm_sorted_map/set, btree_map,
  priority_queue, imm_threading): exponential re-evaluation through the eval
  dispatch cycle. Profile method: `sample <pid> 1` during the stall.

State: attempts #1-#6 preserved on branch `wip/resolution-time-spec`.
Attempt #6 (eager + deterministic spec fids) passed every standing gate but
broke stage2 at self-compile scale (HashMap layout collapse) — its bisect and
a 3-option salvage plan are in
`issues/yo-self-sortedset-method-call-type-void.md`. Salvage option 1 (lldb
one crashing spec in stage2, extract its C, diff against the unspecialized
original) is the designed entry point. **Cheap extra gate for all spec-port
work**: build stage2 and run `s2 check std/env.yo` before any sweep.

### P4 — Iso lowering port (tests/iso.test.yo, tests/rc.test.yo, then iso_api_surface)

iso/rc abort at `get_type_string: Iso lowering is Phase 3 — not yet ported`
(codegen/utils/index.yo `.IsoT` arm). Port TS `getTypeString`'s Iso branch +
iso type collection/runtime. A PORT work item, not a bug hunt.

### P5 — deferred/reverted items (re-land carefully)

- **helper.ts:1314 flag parity** (`is_inside_io_async_call` in the
  UnknownVal-callee arms of calls/function.yo — where builtin io.async calls
  actually land): correct per TS, REVERTED for breaking same-binary
  double-emit determinism (flag-gated capture-info registrations are
  emission-order-sensitive). To land: find which registration diverges
  between two emits of one binary, make it order-stable, then re-apply.
  Ledger item 7 has the exact edit.
- **fs/ + http/ + regex + worker/thread/arc families** (untriaged rc=1):
  likely share roots with the dispose/spec families — re-triage AFTER P3.
- `tests/prelude.test.yo`, `tests/dyn.test.yo`, `tests/derive*.yo`:
  untriaged; grep their batch errors fresh (`YO_KEEP_BATCH=1`).

### Step 3 (after #69 or when instructed): finalization

Fixpoint re-verify (full chain), move resolved `issues/*.md` to
`issues/fixed/`, update `yo-self/README.md` status, mark
`plans/BOOTSTRAPPING.md` historical, delete stale `/tmp` pins.

## HARD-WON INVARIANTS (violate these and you will re-live old sessions)

- **Per-call type identity is THE recurring theme.** TS clones callee types
  per call and mutates per-object; yo-self shares by lineage. Landed
  mechanisms (do not weaken them): `_freshen_io_builtin_callee` (per-call
  forall SomeTs for io.async, calls/function.yo), call-scoped forall rebinds +
  lineage-identity gate (types/synthesizer.yo `_bind_some_type`), the
  constraint-gated Step-2 skip (calls/helper.yo — io.async params skip the
  name-based re-evaluation ONLY when no Future-carrying expected exists;
  WITH a constraint, Step-6b's call-local pre-binds NEED Step-2 as their
  delivery — the un-annotated `(e) => e.io` bundle actions depend on it;
  `tests/codegen-bootstrap/io_async_bundle_field.yo` +
  `closure_capture_rc_dup.yo` are the canaries).
- The evaluator's `->`-handler swallow walls (`_trial_eval_anon_body` etc.)
  hide nested throws and mis-attribute them — when hunting swallowed
  failures, stash the error text into a module global from the handler
  (worked pattern in ledger item 7).
- `extern` language tags normalize to LOWERCASE ("yo"/"c") — compare "yo".
- Trait-associated type NAMES ("Output", "Item") collide with module
  bindings in name-based env walks — never resolve SomeTs by bare name
  without an allow-list (see `_subst_some_types_from_env`'s allow-list in
  evaluator/values/anonymous_function.yo).
- Emitters must agree with the PROTOTYPE renderer on void-ness: resolve
  SomeT results through `resolve_some_type_to_concrete` before
  `is_unit_type` (generate_function_body's `result_is_unit` pattern).
- Names in the captures side-table can be REAL C params (the SM bundle param
  `e`) — in-scope C names take precedence over capture-context rewrites
  (`scope_stack_contains` first; see the sync-future capture literal in
  codegen/exprs/async.yo).
- io-builtin struct fields (`Io`/`JoinHandle` literals) lower to NULL fn
  pointers via the extern-name set {**yo_io_async/await/state/spawn,
  **yo_join_handle_await} (comptime_value.yo `_is_io_builtin_fn_type`).
- `:=` bindings are immutable — reassignment needs a `(x : T) = …` declaration.
- No forward references between top-level `::` bindings — define helpers
  before their callers.
- Yo `match` does not support nested patterns (`.Some(.Struct(...))` fails) —
  flatten with nested `match`. `.None => { expr }` with a single expression
  parses as a struct literal — use `.None => expr`.
- Adding FIELDS to `Frame`/hot types can re-trigger the `_patch_self_shell`
  exponential walk — use id-keyed side-tables (the established pattern).
- fmt every touched .yo file (`./yo-cli fmt`); lint-staged reformats .md on
  commit (later Edit old_strings must match the prettier output).
- A `-O0` binary that SIGSEGVs on deep recursion is stack exhaustion —
  `--release` or `YO_MAIN_STACK_MB=4096`, don't chase ASan (see AGENTS.md).

## KEY LOCATIONS

- `issues/yo-self-async-emission-cluster.md` — the async/dispose/spec
  evidence ledger (items 1-9: the fourteen-probe async arc, every reverted
  candidate with its failure mode, the dispose port design, the `\u` gap).
- `issues/yo-self-sortedset-method-call-type-void.md` — Gap-6 attempts +
  salvage plan.
- `issues/repros/` — committed minimal repros.
  `io-async-result-t-cell-poisoning.yo` (20-line async two-task repro) must
  stay green in every async-adjacent ladder.
- `tests/codegen-bootstrap/` — the 137-file corpus. Async-arc regression
  canaries: `closure_capture_rc_dup.yo`, `io_async_bundle_field.yo`,
  `io_async_fsm_multi.yo` (the last one's pre-2026-07-19 "PASS" was a false
  pass — placeholder comments returning 42 by luck; it now emits real awaits).
- `scratchpad/gates_v18.sh`, `scratchpad/s2_sweep_r19.py` — battery + sweep
  templates (session scratchpad; if gone, rebuild from the battery
  description in THE METHOD above).
- Battery repro files referenced by the gate scripts: `/tmp/tk2.yo
/tmp/counter_check.yo /tmp/sortedset_repro.yo /tmp/ne_repro.yo
issues/repros/dyn-closure-implfn-capture-loss.yo` (the /tmp ones may be
  gone after reboot — recover from git history or drop them from the copy of
  the gate script and rely on corpus + std + fixpoint + flips).

## ROUND-19 RED LIST (54 files — the work queue)

rc=1 (46): arc, cli/arg_parser, closure_capture_rc_leak,
collections/linked_list, collections/ordered_map, comptime, cycle_collector,
derive, derive_clone_complex, dyn, encoding/json, error,
flowability_comprehensive, forward_ref_impl_block, forward_ref_self_method,
fs/dir, fs/file, fs/fs_convenience, fs/metadata, fs/temp, fs/walker,
http/http, imm_list, imm_map, imm_set, imm_string, impl,
impl_fn_field_rejection, module_struct_unification, prelude,
ref_closure_capture, ref_field_borrow, ref_return_ban, regex/regex, str,
sync/atomic, sync/channel, sync/mutex, sync/once, sync/rwlock,
sync/waitgroup, sys/bufio, sys/timer, thread, time/duration, worker.

TIMEOUT (5): collections/btree_map, collections/priority_queue,
imm_sorted_map, imm_sorted_set, imm_threading.

rc=-6 (3): iso, iso_api_surface, rc.
