# The def-eval swallow: remaining roots, measured and attributed

> **CORPUS PHASE (2026-08-13, after the minimal-repro 19 → 0).** The
> WIDER corpus (self-compile of yo-self: 3603 trials; fast repro:
> `issues/repros/`-adjacent driver importing hash_map THEN hash_set)
> exposed a pre-existing family the minimal repro never reached — 5
> swallows, three stacked roots, two FIXED:
>
> - **hash_set ×4 ("Failed to evaluate, got ((ctrl_ptr.add)(i).(\*))") —
>   FIXED** (`5c748639e`): `try_match_generic_impl` passed the caller env
>   RAW as the given side, so every candidate probe's given-side
>   shadow-binds landed durably in the shared trial env; one hash_map-era
>   probe's `T := <hash_map struct>` junk then broke the blanket pointer
>   impl's `T` resolution for every later `.add`. Fix: scratch frame on
>   the given side (TS discards its chains, impl.ts:2243). Also fixed
>   upstream layer (`53ad21724`): `_bind_some_type` now binds a type
>   variable with its KIND (`type_of_type`), not the bound type — TS
>   value.type parity — and its in-place path preserves the old
>   variable's type.
> - **hash_map:714 ("Cannot unify u64 and unit" in the Clone impl's
>   trial) — OPEN, frontier:** the failure is GARBAGE-IN: inside the
>   Clone body's nested `result.set(k, v)` eval, `k` is ALREADY
>   unit-typed — the degrade happens in the
>   `it.next()` → `bucket_ptr.*.key.clone()` chain (hash_map.yo:719-733)
>   before `set` runs; `set`'s param synthesis then binds `K := unit`
>   (call-scoped, legitimately) and the sibling `_find_bucket` spec
>   mints `key : unit`. Two defensive fixes landed alongside
>   (Unit-placeholder guard in `_bind_forall_from_type_args`;
>   trial-scoped callee-env scratch isolation in helper.yo Step 7 —
>   which contained the previously DURABLE cross-trial variant of the
>   K-junk, `[bind-T]` fid-verified). **Frontier (probed to the exact link):** the deref
>   `bucket_ptr.(*)` inside the Clone body ends up UNSTAMPED — `.key`'s
>   object eval runs it (property_access.yo:547) but the node carries no
>   ExprInfo afterwards ([pa-fallthrough] prop=key obj_ty=<no-info>), and
>   NO `prop=*` fallthrough prints, so the deref neither took the
>   pointer-deref arm's stamping paths nor the final fallback.
>   **LAYER 4 (probed via `[pa-deref-in]`):** the deref DOES enter
>   `evaluate_property_access`'s deref arm, but `bucket_ptr` itself is
>   stamped as a BARE STRUCT — `obj_ty=<struct:struct_yo_id_3384>`
>   (generic `Bucket(K,V)`), no pointer wrapper — so every pointer path
>   in the arm misses and it exits without stamping. The healthy sibling
>   line shows what it should be: `(data_ptr.add)((self._index))
obj_ty=*(<struct:struct_yo_id_3134>)`. `bucket_ptr` is bound by the
>   match binder from `it.next()`'s return type `enum_yo_id_3386` =
>   def-time-evaluated `Option(*(Bucket(K, V)))` — and the binder binds
>   `variant_fields_wf.get(i)` verbatim, so enum 3386's `Some` field
>   holds the bare struct: **the `*(...)` wrap was lost when enum 3386
>   was CREATED** — so it first looked like a lost `*` wrap.
>   **ROOT FOUND (layer 5, `[arg-eval]` probe):** enum 3386 is not a
>   mangled `Option(*(Bucket))` at all — it is the perfectly healthy
>   return type of THE WRONG `next`. `[arg-eval]` showed the re-eval
>   evaluating literal AST `Option(Bucket(K, V))` — hash_map.yo:512, the
>   BY-VALUE iterator `HashMapIter`'s `next`. `[tm-try]`/`[fmg-cand]`
>   confirmed the dispatch: for receiver `HashMapIterPtr(K,V)` (struct 3503) BOTH `next` candidates bind — `pat=struct_3370` (HashMapIter →
>   enum 3386) FIRST, `pat=struct_3458` (HashMapIterPtr → enum 3137 =
>   `Option(*(Bucket))`) second — and the first wins. They unify because
>   the trial-scoped STRUCTURAL fallback in the synthesizer's
>   struct-vs-struct arm (added for original root #3) accepts same name
>   - same field labels, and the two iterator structs are both ANONYMOUS
>     (`name=""`) with identical fields `(_map, _index)`. Structural
>     checking can never separate them; only nominal identity (ctor fid)
>     can — TS compares funcIds (synthesizer.ts:662). **FIX:** the shape
>     fallback now requires a MISSING effective cfid on at least one side
>     (its original rescue purpose); when both cfids are known and differ,
>     the pair rejects nominally (`cfid_unknown3` gate,
>     evaluator/types/synthesizer.yo). Hooks in-tree: [rm-early],
>     [rcv-swallow], [pa-fallthrough], [pa-deref-in], [ptr-call],
>     [match-bind], [arg-eval] (YO_DEBUG_CTFE2), `[ctfe-in] callee=` (all
>     YO_DEBUG_CTFE-gated unless noted).
>
> Debug hooks added this phase (all env-gated, in-tree): `[rm-miss]`,
> `[fmg-try]`, `[tm-frames]`, `[call-none] callee_ty`, and
> `[bind-T]`/`YO_DEBUG_BIND=<name>` (write-side frame-id tracing in
> `_bind_some_type`).

> **STATE 2026-08-13 (third session, later): 19 → 0. ALL ROOTS FIXED.**
> Root 537's true root was a MIS-PORT in `_filter_receiver_methods`
> (yo-self/env.yo): the pointee-vs-receiver check used the LENIENT
> compatibility variant where TS passes `requireExactMatch=true`
> (env.ts:1322-1329; compatibility.ts:823-827 makes an unconstrained
> SomeType reject concrete types under exact rules). The lenient check
> marked blanket `impl(generic(T), *(T), add)` methods with
> `needs_pointer_conversion` for an ALREADY-POINTER receiver → `&`-wrap →
> `T := *(T_arr)` synthesis → the `*(T)` return doubled to `*(*(T_arr))`.
> Three resolution-side theories were built and REFUTED first (occurs
> check; ownership-refined occurs; id-keyed synthesis channel — which
> faithfully served the wrong binding, proving the writer upstream); the
> `[s9-init]`/`[rsd-dbl]`/`[occ-pass]` YO_DEBUG_RET hooks carried the dig.
> Fix commit `aac04c097` on `swallow/somet-compat-trial` (PR #119).
> Battery: sweep 188/188 GREEN, canaries incl. ptr/unsafe/array_list all
> green, check ./std 154/154, check ./yo-self 247/247, fixpoint pending.
>
> **NEXT: the endgame** — make `_trial_eval_fn_body` FATAL (TS parity,
> function-type.ts:499) and re-attempt the corpus; the last fatal attempt
> (2026-08-12) broke 10 files because the swallow was load-bearing, all
> of whose roots are now fixed.

> **STATE 2026-08-13 (third session): 19 → 1 swallow. ONLY ROOT 537 REMAINS.**
> Landed on `swallow/somet-compat-trial` (stacked on `wip/root3-synthesis-layer`,
> PR #117):
>
> - **7837 + 7942 + 7973** — one bug: SomeT-vs-SomeT trial acceptance
>   (compatibility.yo; TS's different-id rule for unconstrained expected
>   params; flag storage moved to types/creators.yo `trial_flag_get`).
> - **7623** — type-ctor CTFE now executes despite unknown VALUE args
>   during trials (comptime_fn.yo unknown-arg gate carve-out,
>   `trial_unknown_nocache` keeps the memo clean).
>
> Both increments: sweep 188/188 GREEN, canaries green (imm_map,
> derive_clone_complex, btree_map, array), check ./std 154/154,
> check ./yo-self 247/247; fixpoint run pending at time of writing.
> Root 537's frontier is unchanged below. After 537: the fatal-handler
> endgame + corpus re-attempt.

> **STATE 2026-08-13 (end of second session): 19 → 7 swallows.** Landed (PR
> #115 + two follow-up commits on `fix/family-a-provisional-static`):
> families A and B, cross-impl abstract bindings (trial-scoped), comptime
> params bound UnknownVal, the ::-vs-:= and typed-binding comptime skips,
> the comptime-CTFE non-FuncVal degrade. Every landed increment is
> sweep-188/188-clean. **All 7 remaining roots are blocked on two
> structural repairs:**
>
> **Repair 1 — trial-stamp staleness (roots #3-class: 797, 616, 537).**
> Def-time trials stamp ExprInfos and side tables on SHARED body ASTs;
> specialization re-eval overwrites the ExprInfoTable (id-keyed) but NOT
> every side channel (method-callee value table, fid registrations,
> runtime-arg exprs). Every dispatch loosening that lets trials resolve
> MORE (the synthesis-layer work on `wip/root3-synthesis-layer` — struct
> structural fallback + type-args abstract recovery — which DID fix the
> dispatch) turns sweep files RED through those channels (10 REDs:
> collections + iterator combinators + where_clause_fn_inference; the
> abstract-spec class before it). Fix the overwrite contract first — make
> every side-table write from a trial either (a) tagged and superseded by
> the specialization re-eval, or (b) suppressed during trials — then land
> the wip branch on top.
>
> **Repair 1's concrete entry point (measured on the preserved r4
> binary):** `tests/collections/btree_map.test.yo`'s batch main fails
> `check_if_function_parameter_matches_argument: arg has no ExprInfo` at a
> CONCRETE `for((m.iter)(), ptr => ...)` — i.e. a TRIAL-time abstract match
> during module eval left a durable write that redirects BATCH-time
> resolution. Prime suspects inside `try_match_generic_impl`'s success
> path: the "DURABLE assoc-type registration at first success"
> (`register_type_trait_method` under the trial receiver's id) and
> `register_some_resolved_concrete`. Instrument those two writes with the
> trial flag on the wip branch and diff a batch run.
>
> **Repair 2 — SomeT-keyed type-constructor CTFE (roots 7623, 7837, 7942,
> 7973).** TS RUNS type-ctor CTFE with SomeType args (`IterPair(usize, A)`
> yields a real struct type with abstract fields); yo-self deliberately
> skips it (`ou_all_known` — "a validation-pass SomeT TypeVal must not
> mint, it would cache-key junk", the gap-6 lesson), so the callee
> degrades to `UnknownVal(Type(1))` and every downstream member check
> fails. The fix needs trial-scoped instantiation that does NOT pollute
> the CTFE cache — e.g. a separate trial-era cache keyed by SomeT ids,
> discarded with the trial, mirroring TS's shared-object model without its
> in-place mutation.
>
> The endgame (fatal `_trial_eval_fn_body`) stays gated on all remaining
> roots + a corpus-wide re-attempt.
>
> **LATER SAME SESSION — repair 1 landed** (`wip/root3-synthesis-layer`,
> PR #117): the flow-site `in_def_time_trial` flag was the leak (concrete
> fns' trial stamps ARE codegen's input — batch mains included); with it
> off, the synthesis loosenings are safe (sweep 188/188) and roots 797 +
> 616 cleared. **5 roots remain.**
>
> **Root 537's frontier** (minimal repro `scratchpad/idx537.yo`, hooks
> in-tree): the Index-impl trial's `_ptr.add(idx)` — dispatch, match, and
> the finder's substitution are all CORRECT (`[fmg-cand]` shows
> `fn(self : *(T)) -> *(T)` with T properly bound to the G-impl's SomeT —
> both binders are NAMED T so the print looks unsubstituted). The doubling
> to `*(*(T))` therefore happens in the CALL-SITE return resolution after
> dispatch (the "call-time SomeT synthesis, whose frame levels are stale"
> warning in find_methods_from_generic_impls' own comment). Next: trace
> the runtime-return path's resolved_ret computation for this call.
>
> **REPAIR 2 RE-DIAGNOSED (2026-08-13, third session, `YO_DEBUG_CTFE`
> instrumentation — comptime_fn.yo/function.yo/type.yo, in-tree).** The
> "SomeT-keyed type-ctor CTFE" framing was WRONG for 3 of the 4 roots.
> Measured per-root ground truth:
>
> - **7837, 7942, 7973 are ONE bug, and it is NOT CTFE.** The type-ctor
>   CTFE **executes fine** with SomeT type args (`IterPair(usize, A)` →
>   fresh anonymous struct per call; no cache under the SomeT carve-out —
>   faithful enough for trials). The actual failure is the MEMBER
>   compatibility check: `[tycall-mismatch] label=_1 expected=A got=Item`
>   — yo-self's SomeT-vs-SomeT rule (name+frame_level identity,
>   compatibility.yo) REJECTS two different type params, while TS
>   (compatibility.ts:676-744) ACCEPTS different-id SomeTypes whenever the
>   given side satisfies the expected side's constraint set (trivially
>   true for an unconstrained forall `A`). Fix: trial-scoped, non-exact,
>   empty-expected-constraints acceptance in compatibility.yo's SomeT arm
>   (the flag storage moved to types/creators.yo `trial_flag_get` to avoid
>   the evaluator-layer import cycle). NOT the full TS subset walk — that
>   port self-recursed unboundedly (see the arm's history note).
>   Note: in 7942/7973 the inner mismatch's exn.throw does NOT surface —
>   evaluation continues and the OUTER `.Some(...)` member check reports
>   `got=Type(1)` (a stale checking-phase stamp on the construction node),
>   which is what made the message misattributable to CTFE.
> - **7623 alone is the CTFE-degrade root**: `_ArrayIter(T, N)` carries a
>   VALUE comptime param (`N : usize`, bound `<unknown: usize>` at def
>   time) → `[ctfe-unk-arg]` (comptime_fn.yo's unknown-arg execution gate)
>   → `_ctfe_unknown(Type)` = a fresh bare SomeT → "TypeVal SomeT callee
>   without FnTrait (Phase 4)". TS EXECUTES type-ctor bodies with
>   UnknownValue args (its recursion protection is the in-progress temp
>   cache, comptime-fn.ts:188-203, pushed unconditionally). Candidate fix:
>   during trials, let type-hierarchy-returning ctors execute despite
>   unknown VALUE args; recursion safety needs a trial-era in-progress
>   entry since the SomeT carve-out disables the durable cache.

**Live inventory.** `_trial_eval_fn_body`
(`yo-self/evaluator/calls/function_type.yo`) wraps definition-time body
evaluation in a capture-free handler that unwinds `()` on ANY error, and the
FuncVal registers anyway. TS's counterpart (`function-type.ts:499`) is FATAL, so
**every swallowed error is a place where yo-self's definition-time environment is
thinner than TS's** — and a body whose statements lose their ExprInfo is exactly
what codegen turns into a `// Failed to transpile` comment.

Making the handler fatal is the endgame. It can only happen AFTER these roots are
gone: an attempt at the fatal version (2026-08-12) broke 10 corpus files, because
the swallow is currently load-bearing.

## How to reproduce this inventory

```bash
# Any stage-1 binary from this tree; the hook is in-tree, not scaffolding.
YO_DEBUG_SWALLOW=1 <bin> compile <file.yo> --emit-c --skip-c-compiler -o /tmp/x 2>&1 \
  | awk '/\[trial\]/{t=$2} /\[swallow\]/{sub(/.*\[swallow\] /,""); print t"\t"$0}' \
  | sort | uniq -c | sort -rn
```

`[trial] <module>:<row>:<col>` is printed before each definition-time trial;
every `[swallow]` belongs to the `[trial]` above it. The marker exists because
the handler is a capture-free `->` and **cannot** capture `body`, so the owner
cannot be printed from inside it — and many swallowed errors carry a token
pointing at line 1, which makes the message alone unattributable.

Use a MINIMAL input (prelude + `std/fmt` only). A program importing `yo-self/`
adds its own roots and drowns the baseline.

## Progress

| stage                         | distinct roots | `Variable "X" not found` |
| ----------------------------- | -------------- | ------------------------ |
| baseline (2026-08-13)         | 33             | 17                       |
| + generic TYPE binders bound  | 17             | 1                        |
| + generic VALUE binders bound | 16             | 0                        |

Both landed with the full battery: FIXPOINT_HOLDS, sweep 188 GREEN,
`tests/internal` 868 passed / 0 markers, `check ./std` 154/154,
`check ./yo-self` 247/247.

## The remaining 16, attributed to the function being trialled

| #   | owner (fn whose body was trialled)                         | swallowed error                                            |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `array_list.yo:73:59` `slice_copy`                         | Cannot unify incompatible types: `usize` and `unit`        |
| 2   | `array_list.yo:89:78` `slice_copy_inclusive`               | Cannot unify: `usize` and `unit`                           |
| 3   | `array_list.yo:797:45`                                     | Cannot unify: `usize` and `unit`                           |
| 4   | `array_list.yo:881:74` `slice_copy` (Array impl)           | Cannot unify: `usize` and `Type`                           |
| 5   | `array_list.yo:890:93` `slice_copy_inclusive` (Array impl) | Cannot unify: `usize` and `Type`                           |
| 6   | `prelude.yo:7608:6`                                        | Cannot unify: `usize` and `Type`                           |
| 7   | `array_list.yo:116:4`                                      | Incompatible type with expected type                       |
| 8   | `array_list.yo:537:68`                                     | Incompatible type with expected type                       |
| 9   | `array_list.yo:616:6`                                      | Incompatible type with expected type                       |
| 10  | `array_list.yo:383:4`                                      | Type mismatch for type member "value"                      |
| 11  | `prelude.yo:7837:49`                                       | Type mismatch for type member "value"                      |
| 12  | `prelude.yo:7942:6`                                        | Type mismatch for type member "value"                      |
| 13  | `prelude.yo:7973:6`                                        | Type mismatch for type member "value"                      |
| 14  | `prelude.yo:578:8`                                         | evaluate_comptime_fn_call: function_value is not a FuncVal |
| 15  | `prelude.yo:599:4`                                         | evaluate_comptime_fn_call: function_value is not a FuncVal |
| 16  | `array_list.yo:188:4`                                      | Failed to evaluate, got `(last_element_ptr.(*))`           |
| 17  | `array_list.yo:211:4`                                      | Failed to evaluate argument expression                     |
| 18  | `prelude.yo:5611:51`                                       | `__yo_array_fill` expects a compile-time known second arg  |
| 19  | `prelude.yo:5801:4`                                        | Expected ComptimeList value for `__yo_comptime_list_car`   |

(19 swallows across 16 distinct `(location, message)` roots.)

## Two families identified, with evidence

### A. Sibling-method calls evaluate to `unit` (#1, #2, #3 — the "Self-slot" class)

```rust
slice_copy : (fn(self : Self, r : Range(usize)) -> Self)({
  e := cond((r.end > self.len()) => self.len(), true => r.end);
```

`self.len()` yields `unit` at definition time, so the `cond` arms cannot unify
(`usize` vs `unit`).

### Measured facts (2026-08-13) — and TWO refuted causes

Bisected by editing `std/collections/array_list.yo` self-revertingly and
recompiling a 4-line importer (~25 s per iteration, no compiler rebuild — `std`
is read fresh by any stage-1 binary):

| variant of `slice_copy`'s first statement    | swallowed error                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| original `cond((r.end > self.len()) => ...)` | Cannot unify: `usize` and `unit`                                                      |
| `e := self.len();`                           | Cannot unify: `usize` and `unit` (so `e` is unit ⇒ `self.len()` is unit)              |
| `e := r.end;`                                | Expected enum type … for match expression, got `unit` (the `match(self.get(i), ...)`) |

So **both** sibling calls are unit: `len` (declared at :29, BEFORE `slice_copy`
at :74) and `get` (declared at :211, AFTER it). Removing one statement simply
exposes the next failure in the same body.

**Refuted cause 1 — "methods are not registered until the module literal
finishes".** A plain `impl(M, len : ..., via_instance : ...)` where `via_instance`
calls `self.len()` inside a `cond` RESOLVES cleanly at definition time (rc=0, 0
markers, no swallow).

**Refuted cause 2 — "it needs a generic impl whose `Self` carries an unresolved
type argument".** The same probe rebuilt as
`G :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(v : T, n : usize)))`
with `impl(generic(T : Type), G(T), size : ..., via : ...)` — mirroring
ArrayList's exact declaration shape, sibling declared first — ALSO resolves
cleanly.

### THIRD FACTOR FOUND: `Self.<method>()` static dispatch (2026-08-13)

Minimal reproducer: **`issues/repros/self-static-method-at-def-time.yo`** (15
lines of substance) — reproduces the exact `usize`/`unit` error.

The trigger is `out := Self.new();` — STATIC dispatch on `Self` inside a method
body at definition time. Narrowed by probe series:

| probe                                                              | result         |
| ------------------------------------------------------------------ | -------------- |
| `?*(T)` field + `pragma(AllowUnsafe)`                              | clean          |
| ... + a `Range(usize)` parameter                                   | clean          |
| ... + `new : (fn() -> Self)(...)` declared AND `Self.new()` called | **REPRODUCES** |
| ... + `new` declared but NOT called                                | clean          |

Instance dispatch (`self.len()`) works throughout, before or after its
declaration. So it is specifically STATIC-on-`Self` that fails.

**The root is DELIBERATE.** `evaluator/values/impl.yo:3110-3114` makes only
TYPE-valued fields visible to later fields' `Self.X`:

> Only TYPE-valued fields (associated types like `Output : u8`) — `Self.X` never
> resolves to a method value, and copying FuncVals into the context list proved
> fragile.

So a sibling METHOD is unreachable through `Self` during the impl's own
evaluation; `Self.new()` yields `unit` and the trial swallows the body. The
`g_method_values` path at `:2578-2585` has the same TYPE-only restriction.

This IS the documented "Self-slot" class after all (`(result : Self) = Self.new()`
types UNIT) — an earlier note in this file said it was not; that was wrong.

### Attempt 2026-08-13 — implemented in TWO places, neither fires (reverted)

Both halves type-checked at 247/247 and BOTH were built and measured; the repro
still swallows and the root count stays at 16, so neither path is the one
`Self.new()` actually takes.

1. **`property_access.yo`'s `Self.X` fallback** extended to resolve a
   FUNCTION-typed entry to its FuncVal (ExprInfo type = the Func type, value =
   the FuncVal), with `impl.yo` publishing sibling methods into the in-flight
   context lists — the method VALUE in a NEW parallel list
   (`current_impl_trait_field_values`) rather than in
   `current_impl_trait_field_types`, since conflating methods with associated
   types is the likely reason the older attempt "proved fragile". No effect:
   `Self.new()` is a CALL, so it does not come through property access.
2. **`calls/function.yo`'s static-dispatch path**, where `hits.len() == 0`
   returns `None` and the call degenerates to `unit`: added an in-flight-impl
   fallback that scans the same context lists and synthesizes a `MethodEntry`
   hit, scoped to `is_static` and FuncVal-valued entries. Also no effect.

So the call is resolved somewhere neither of those covers, OR the context lists
are empty at that moment (the push happens per-field as the impl is evaluated,
and `new` precedes `via` in the repro, so they SHOULD be populated — unverified).

### INSTRUMENTED 2026-08-13 — where it actually breaks

Two probes (`PROBE-SELFX` at the `Self.X` fallback, `PROBE-PUSH` at each impl
field push), built and run against the reproducer:

1. **The `Self.X` fallback IS reached** for `prop=new` — so it is not shadowed by
   an earlier branch, as suspected.
2. **But it sees `n_labels=0`**: the in-flight context lists are EMPTY at the
   moment `Self.new` resolves. That is why both earlier fix locations were inert.
3. **The push fires on two different paths.** With only the generic-impl branch
   (`g_mval`, impl.yo ~:2578) patched, pushes appear for `clone`, `dispose`,
   `hash`, `index`, `next`, `trace` — all TRAIT-impl methods, never the
   reproducer's `len`/`new`/`via`. An INHERENT impl
   (`impl(generic(T), G(T), len, new, via)`) goes through the "Case 3" site
   (~:3110) instead; patching that too fires 885 pushes.
4. **Even with both pushing, `Self.new` still sees `n_labels=0`.** So the lists
   do not survive from the push into whatever context evaluates the body.

Also established:

- Pushing methods into `current_impl_trait_field_types` WITHOUT the matching
  consumer branch breaks 87 files, while the two together are 247/247. That is a
  concrete explanation of the original "copying FuncVals into the context list
  proved fragile" note: the earlier attempt most likely landed the push without a
  consumer.
- The impl RESTORES the saved lists when it finishes (impl.yo:2607 and :3431),
  and `PendingDefEval` carries none of them — but the deferred-re-run path is
  gated on `has_fwd_comptime_fn_cap`, which is narrow, so "the trial re-runs
  after the restore" is NOT the explanation either (checked, not assumed).

### REFUTED 2026-08-13 (later, by ordering probe) — READ THIS BEFORE THE SECTION BELOW

**The section immediately following is WRONG and is kept only for its
measurements.** Its conclusion — "the def-time body trial happens outside the
impl's field loop" — was inferred from `n_labels=0` and is false.

A probe printing `[field-begin]`/`[field-end]` around BOTH field-evaluation sites
(Case 2's direct colon-pair branch, `impl.yo:2458`; Case 3's, `impl.yo:3110`),
interleaved with the existing `[trial]` line, shows the trial nested INSIDE the
field window — on the reproducer AND on the real `array_list` target:

```
[field-begin] case2 recv=struct_yo_id_3171 name=new
[trial]       std/collections/array_list.yo:57:4
[field-end]   case2 recv=struct_yo_id_3171 name=new
[field-begin] case2 recv=struct_yo_id_3171 name=slice_copy
[trial]       std/collections/array_list.yo:73:59
[swallow]     Error: Cannot unify incompatible types: "usize" and "unit"   <- root #1
[field-end]   case2 recv=struct_yo_id_3171 name=slice_copy
```

Two facts follow, and they reopen the whole approach:

1. **The trial runs inside the field loop**, so a LOOP-SCOPED channel (the
   provisional registry, cleared at loop end) IS live at trial time. The
   permanent registration that regressed `imm_map` is not required.
2. **`new` reaches `[field-end]` before `slice_copy` reaches `[field-begin]`** —
   its real, fully-evaluated FuncVal already exists when the failing body is
   trialled. No forward shell is needed for this class at all.

**Why the earlier probe measured `n_labels=0`:** it patched the wrong branch. The
`g_mval` push site (`impl.yo:2581`) sits inside Case 2's TRAIT-CONSTRUCTOR branch
— the one guarded by `!(BK_COLON)` — while the fields that actually fail
(`len` / `new` / `via`, and `array_list`'s `new` / `slice_copy`) are direct
`name : fn` pairs handled by the branch at `impl.yo:2458`. Nothing was ever
pushed for them, so the lists were empty for a mundane reason. The 885 pushes
that "fired" were all other impls. Case counts in one full compile of the
reproducer: **200 case2 fields, 2600 case3 fields.**

Reproduce with the 14-line patch in `plans/HANDOVER_DEF_EVAL_SWALLOW.md` §4.

### SUPERSEDED 2026-08-13: "the context-list approach CANNOT work"

Final probe — `n_labels` printed at the `[trial]` site itself, WITH both pushes
applied (885 pushes firing elsewhere in the same compile):

```
[trial] .../self-static-method-at-def-time.yo:32:48 n_labels=0
[trial] .../self-static-method-at-def-time.yo:40:23 n_labels=0
[trial] .../self-static-method-at-def-time.yo:41:52 n_labels=0   <- via, the swallowing one
```

Every method-body trial runs with the in-flight lists EMPTY. Since the push
happens after each field's own evaluation, `via` (field 3) would see `len` and
`new` if it were trialled inside the impl's field loop — it does not. **So the
def-time body trial happens outside that loop, and no amount of publishing into
`current_impl_trait_field_*` can reach it.**

(Method note: the first run of this probe was measured with the pushes REVERTED,
where `n_labels=0` is trivially true and proves nothing. The result above is the
corrected run.)

**Therefore the fix direction changes.** `Self.<method>()` has to become
resolvable through a channel that is live wherever the trial runs — i.e. register
each impl method into the ordinary type-method registry INCREMENTALLY, as each
field is evaluated (`register_type_trait_method` per field), so normal static
dispatch finds it. That is a larger change than the context lists and needs its
own gated slice, but it is now the only direction consistent with the evidence.

Ruled out for good, with measurements: the property-access `Self.X` fallback
(reached, but lists empty), the static-dispatch fallback in `calls/function.yo`
(never fires), and both push sites (fire, but not during the trials).

**The one remaining question, and the exact next probe:** add `n_labels` to the
existing `[trial]` print in `_trial_eval_fn_body`. If the trial itself already
runs with empty lists, the body eval happens outside the impl's field loop and
the lists must be carried to it; if the trial has them populated, the loss is
inside the body evaluation's context threading (`function_type.yo`'s
`create_function_body_evaluation_context` copy).

That single bit decides which half to fix, and costs one build.

**Next step must be instrumentation, not a third guess**: print at
`_try_find_receiver_method` entry whether `is_static` is true for `Self.new()`
and what `ctx.current_impl_trait_field_labels` contains at that moment. Two build
cycles were spent on plausible-looking locations that never executed; a single
`[trial]`-style probe would have named the right one first.

**Fixing it means making FuncVal fields resolvable for `Self.X` at def time —
exactly what a previous session tried and abandoned as fragile.** TS has no such
limitation (its def-time body eval is fatal and it compiles `array_list` fine),
so it is a real porting gap rather than a design choice to keep. Any attempt
needs the full battery plus the stage-2 marker count, since the abandoned attempt
was abandoned for fragility, not for being wrong.

### ATTEMPT 2026-08-13 — forward shells in Case 2: REGRESSES, do not retry as written

The direction proposed just above (register impl methods into the ordinary type
registry so normal static dispatch finds them) was implemented as the missing
**forward-shell pre-pass in Case 2** (generic impls). `_try_create_forward_shell`
has exactly ONE call site in `impl.yo` — Case 3 (~:2862, non-generic impls) —
while TS runs its equivalent for both paths, since `evaluateImplFieldList`
(impl.ts:590) is shared. So the asymmetry is real, and the patch mirrored Case 3:
`register_type_trait_method(<receiver pattern id>, shell)` for each direct
function-typed field, evaluated in `forall_env`.

**It works on the reproducer and regresses the corpus.**

| measurement                                       | result                                           |
| ------------------------------------------------- | ------------------------------------------------ |
| `issues/repros/self-static-method-at-def-time.yo` | rc=0, own-swallows 1 → **0**, FTT 0              |
| baseline distinct roots                           | 16 → **16** (no change)                          |
| `check ./yo-self`                                 | 247/247                                          |
| fixpoint                                          | FIXPOINT_HOLDS                                   |
| hollow sweep                                      | **`tests/imm_map.test.yo` RED** (new regression) |

`imm_map` is GREEN in all ten prior sweeps on record (`/tmp/hsweep_*`, oldest
2026-08-09, newest 3 h before this build); the only tree difference was this
patch. It fails as an untranspiled expression in the batch `__yo_user_main` — the
entry-point marker gate — i.e. the patch caused precisely the silent-miscompile
class this whole campaign exists to remove.

Attribution was then CONFIRMED against a control, not inferred from the sweep
history: a binary built from the identical tree with only `impl.yo` reverted runs
`tests/imm_map.test.yo` at **21 passed / rc=0**, while the patched binary is RED
on the same file. (Build the control in the main repo — a `git worktree` has
EMPTY submodule dirs, so `vendor/markdown_yo` is missing and `main.yo` dies with
the unhelpful `file or directory not found`.)

**Root cause of the regression — the registry is the wrong one.** Case 3 may
register shells into `type_trait_methods` because Case 3's main pass **supersedes
each shell in place** (`impl.yo:3199-3238`, matching on
`source_trait_id == "__forward_shell"`) and records a shell→real redirect for
codegen. **Case 2 has no supersede path at all**: it accumulates methods into a
`GenericImplEntry` (`method_names` / `method_types` / `method_values`, consumed by
`try_match_generic_impl`) and never calls `register_type_trait_method`. So the
shells become the ONLY entries under that receiver id, permanently, each carrying
an UNEVALUATED body — and dispatch that used to fall through to generic-impl
matching now finds a shell and emits it.

TS never has this problem because its shells are not global. It pushes them onto
a **clone** of `receiverType.trait.fields` (impl.ts:576-585, guarded by the
`fields: [...receiverType.trait.fields]` copy at impl.ts:613-619) and **restores
the original trait at impl.ts:899**. The shells are scoped to the impl's own
field evaluation and leave no residue.

**If retried, the yo-self analogue is the PROVISIONAL registry, not the permanent
one.** `register_provisional_trait_method` / `clear_provisional_trait_methods`
(`values/type_trait_methods.yo:187-250`) is already documented as the port of
exactly this TS splice — registered during member evaluation, cleared when the
loop finishes.

**VERIFIED by reading, no build needed: the static path does NOT consult it.**
`Self.new()` is `is_static` (`calls/function.yo:313`, receiver value is a
`TypeVal`), so it resolves through
`get_type_trait_methods_by_name_from_env` (`env.yo:2736`), whose only three
sources are the trait-qualified special case, the PERMANENT registry
(`get_type_trait_methods_by_name`, :2780), and the generic-impl fallback
(:2784-2790). The provisional registry's only consumer is
`get_receiver_methods_by_name_from_env` (`env.yo:3207,3222`) — INSTANCE dispatch.
So a provisional-registry fix needs BOTH halves: register during the loop AND add
a provisional consult to the static lookup as a last-resort fallback. Landing the
registration without the consumer is inert; landing a consumer that outranks the
generic-impl fallback is how `imm_map` broke.

Note also that shells may not be needed at all here: in both the reproducer and
`array_list`, the sibling (`new`) is declared BEFORE the caller (`via` /
`slice_copy`), so its REAL FuncVal already exists when the caller's body is
trialled. Registering real values, scoped and cleared, is strictly safer than
registering unevaluated shells.

**The one thing that must be measured first**, because it decides whether ANY
scoped mechanism can work: the probe series recorded above found the in-flight
context lists EMPTY at the trial site even with 885 pushes firing elsewhere,
which was read as "the trial runs outside the impl's field loop". If that is
literally true, a registry cleared at loop end is already empty by trial time and
only a permanent registration could work — which is exactly the unsafe option.
Resolve that contradiction (print at both the field-loop push and the trial, with
the receiver id, in ONE build) before designing anything further.

**But the decisive fact is that this is not family A's root cause.** Even with
shells created and dispatched correctly, the root count stayed 16 → 16, because
`_try_create_forward_shell` returns `.None` whenever `_trial_eval_fn_type_head`
cannot evaluate the signature — and it cannot for `array_list`'s methods
(`Range(usize)`, `?*(T)`, `Option(T)`, `ArrayListError`), while the reproducer's
simple `fn(self : Self) -> usize` succeeds. **The next probe is therefore why that
signature evaluation fails, not how the resulting shell is stored.** That is also
the single measurement that would have pre-empted this whole attempt.

Method note: an earlier variant of this patch passed `local_env` instead of
`forall_env`. It made `array_list`'s own swallows vanish — but broke module
evaluation with `Variable "ArrayList" not found`, i.e. the shells were built in an
env where the receiver's own nominal type is not yet bound. That `local_env`
reached array_list's methods where `forall_env` does not is itself a clue worth
following.

(Superseded note: a third factor WAS unidentified when this section was first
written.)

**Superseded — the following was the state before the probe series.**

**So a third factor distinguishes the real `array_list` impl from a minimal
generic impl with the same shape, and it is not yet identified.** Candidates not
yet tested: the `?*(T)` optional-pointer field, `pragma(Pragma.AllowUnsafe)`, the
number of methods in the impl (ArrayList has dozens; the probes had two), or
interaction with a method that itself failed its trial earlier in the same impl
(note `[trial] :57:4` runs immediately before `[trial] :73:59`).

Related but NOT the same as the documented "Self-slot" class
(`(result : Self) = Self.new()` types UNIT —
`issues/retired/yo-self-hollow-test-batch-main.md`); that one is about `Self.X`
static access, this one is instance dispatch.

Next probe: extend the minimal generic-impl repro one property at a time toward
the real ArrayList (optional-pointer field → many methods → a preceding failing
trial) until it reproduces; that names the third factor without guessing.

### IMPLEMENTED 2026-08-13 (branch `fix/family-a-provisional-static`) — the §3 handover shape, measurements pending

The three-part fix from `plans/HANDOVER_DEF_EVAL_SWALLOW.md` §3, with one
correction found by reading: **Case 3 needs NO new registration.** Its field
loop already registers each method into the PERMANENT registry as the field
completes (`impl.yo` `register_type_trait_method` in-loop, plus the
forward-shell supersede), so static `Self.X` on a non-generic impl resolves
mid-loop today. The gap is Case 2 only: methods accumulate into the
`GenericImplEntry` registered only AFTER the loop, so nothing is visible
mid-loop through any channel static dispatch consults. That also matches the
probe log — every failing field was tagged `case2`.

The change:

1. Case 2's direct colon-pair branch registers each evaluated method into the
   PROVISIONAL registry as its field completes — with the REAL forall-stamped
   FuncVal (`value : .Some(m_to_push)`, `source_trait_id : ""`,
   `self_type : None` — the same shape as Case 3's direct permanent entries),
   NOT a valueless signature splice.
2. `get_type_trait_methods_by_name_from_env` (env.yo) consults the provisional
   registry as the LAST resort, ranked BELOW the generic-impl fallback (an
   in-flight entry outranking a registered impl is how `imm_map` broke).
3. Cleared at Case 2's field-loop end, next to the `self_type` restore.

Known interaction accepted by design: the INSTANCE path
(`get_receiver_methods_by_name_from_env`) also consults provisional when the
permanent registry misses, so mid-loop instance calls (`self.len()`) may now
resolve through these entries instead of whatever later fallback served them
before. The entries carry real values and the Case-3-direct shape, so this is
the faithful-port direction (TS shows in-flight evaluated fields to both
paths); the full battery is the arbiter.

### LANDED 2026-08-13 (branch `fix/family-a-provisional-static`) — families A and B, measured

Three commits, each measured on the std baseline (importer of std/fmt):

| stage                                                   | swallows |
| ------------------------------------------------------- | -------- |
| baseline (post-PR #110)                                 | 19       |
| + per-field provisional registration (earlier siblings) | 18       |
| + forward shells (later siblings) + trait-ctor + fam B  | 14       |

Roots cleared: #1, #2 (slice_copy family, incl. the transient with_capacity
and from_array layers), #4, #5 (Array slice_copy — family B), #7. #6
progressed to its next layer (prelude 7623, SomeT callee).

**Layered findings, in discovery order:**

1. **Earlier siblings** (`Self.new()` before `slice_copy`): per-field
   provisional registration with the REAL forall-stamped FuncVal; static
   lookup consults provisional LAST (below the generic-impl fallback).
2. **Shell values are uncallable** — a shell FuncVal carries an EMPTY
   capture snapshot, and the inline-FuncVal call arm builds the body env
   from it (`capture_env_for`), so calling a shell evaluated its body in an
   env with NO module bindings (`Variable "GlobalAllocator" not found`,
   push's body from slice_copy's trial). Provisional forward entries must
   carry `value : None` — callable from the TYPE alone, the trait-splice
   contract.
3. **The eager pre-pass itself diverges imm_map** — experiment B (pre-pass
   head-evals kept, registration DISABLED) still turned
   `tests/imm_map.test.yo` RED: `Map(i32,i32).new()`'s batch-time
   specialization failed `Type mismatch for type member "_root": Expected
<enum>, Got Type(1)`. The poison is the EARLY evaluation of every
   field's signature head (map.yo's `Map(K, U)` instantiations), not the
   entries. A `YO_C2_PREPASS_SKIP` bisect build confirmed module locality:
   skipping only imm/map went GREEN. The underlying instantiation-order
   fragility is still unexplained — TS runs the same eager shape safely.
4. **Resolution: lazy materialization.** Case 2 pushes an in-flight record
   (receiver id, unevaluated colon-pair fields incl. trait-constructor
   inners, forall env, ctx); env.yo's provisional-miss paths call
   `materialize_in_flight_method` (callback slot), which head-evals ONLY
   the sibling actually asked for, once per label. Sweep: 188/188 GREEN
   expected (imm_map verified 21/21 directly; full sweep pending).
5. **Family B**: name-only side table (`types/creators.yo`), registered
   syntactically at the impl binder site, resolved PURELY (builtin scalar
   names) in `_build_def_time_body_env`'s capture copy, cleared with the
   impl. The forall-env binding stays `TypeVal(SomeT)` (load-bearing for
   receiver-pattern eval).

### Abstract-binding acceptance (root #3 / cross-impl) — the ledger of scoping attempts

The TS contract (tryMatchGenericImpl substitutions extraction): a binding
unified to a DIFFERENT SomeType counts as bound. yo-self's
`_resolve_one_forall_binding` rejected every SomeT. Landing the acceptance
took three scopings, each measured:

| variant                                           | swallows | canaries                                    |
| ------------------------------------------------- | -------- | ------------------------------------------- |
| accept everywhere (id + name channels)            | 4        | **std module eval BREAKS** (std/string)     |
| id channel only                                   | 13       | all green — but array_list roots return     |
| id always + name channel gated to def-time trials | 10       | imm_map green; **derive_clone_complex RED** |

The name channel is what resolves array_list's cross-impl dispatch (the id
channel misses those bindings); unscoped it picks up unrelated same-name
SomeTs from outer scopes. `in_def_time_trial` (context.yo) is set around
the three `_trial_eval_fn_body` call sites (a swallowed error unwinds OUT
of the helper, so in-helper restore is unreachable — set/restore lives at
the call sites) and `_materialize_default_body`'s call site.

**derive_clone_complex regression (open):** the batch C calls
`yo_id_..._rtparam0_R_gs_...` — a specialization MINTED WITH AN ABSTRACT
type in its key. The emitter skips a SomeT-laden spec as hard-generic while
the call site still emits the direct call. A guard skipping the mint when
`in_def_time_trial() && (bindings or args contain SomeTs)` did NOT fix it —
the mint happens OUTSIDE any flagged trial (context still unidentified; the
`[abstract-spec]` YO_DEBUG_SWALLOW print at the mint's register site names
fid + flag state for the next run). Two def-time degrades (comptime CTFE
non-FuncVal → unknown; SomeT callee → unknown) were tried alongside and
REVERTED: they let trials proceed deep enough to stamp partial ExprInfos
that leak into emitted specializations (imm_map RED again, FTT comment
INSIDE `map_values`' emitted C).

**The structural lesson:** yo-self's def-time trials stamp ExprInfos on
SHARED body ASTs that codegen consumes directly for some shapes (derive
bodies, batch mains). Converting a MISSING stamp into an ABSTRACT stamp
trades statement-level FTT markers for miscompiles unless every abstract
product is kept out of codegen's channels (fid recording, spec minting).
Any further degrade must answer "which codegen channel can this abstract
value reach?" before landing.

### Root #3 (797, Clone impl) — discriminator narrowed to the TRAIT-CONSTRUCTOR field path (2026-08-13, probes on the trial-scoped build)

Probe series (`scratchpad` cc\_\* files, two impls on `G(T)` where the second
calls the first's `len`; the CALLER must return a SomeT-containing type or no
dg-trial runs and the pass is VACUOUS — `via2/via3` returning `usize` "passed"
that way):

| second impl's shape                                     | def-time trial |
| ------------------------------------------------------- | -------------- |
| direct field, `self : Self`, returns `Option(usize)`    | resolves       |
| direct field, `inout(self) : Self`, returns `Option(…)` | resolves       |
| direct field + `where(T <: Clone)`                      | (vacuous)      |
| `Clone(clone : …)` trait constructor                    | **swallows**   |
| CUSTOM trait constructor (`MyT(via5 : …)`)              | **swallows**   |

So cross-impl dispatch inside a TRAIT-CONSTRUCTOR field's trial still fails
where the direct branch (same receiver, same call) now succeeds. The
suspected difference: the g\_ branch evaluates fields with
`ctx.expected_type` = the trait's substituted field type, while the direct
branch CLEARS expected_type.

**ATTEMPTED AND REVERTED (branch `wip/root3-synthesis-layer`):** the
synthesis-layer fixes for this — a trial-scoped struct-shape structural
fallback in `synthesizer.yo`'s struct arm (the enum arm's twin) plus
trial-scoped abstract acceptance in `_bind_forall_from_type_args` — DID
resolve the dispatch (root 797/616 progressed into the ::-vs-:= comptime
binding layer, canaries `imm_map`/`derive_clone_complex` both green), but
the hollow sweep turned **10 files RED**: the whole `tests/collections/`
family, `iter_filter_closure`, `iterator_combinators`,
`where_clause_fn_inference`. The struct fallback alone (unscoped
intermediate binary) already breaks `btree_map`, and the scoped r4 build
fails it identically — the same structural lesson yet again: trial-time
resolutions stamp shared body ASTs that codegen consumes, so ANY loosening
that lets trials resolve more surfaces as miscompiles until the underlying
staleness (specialization re-eval must OVERWRITE trial stamps) is fixed.
**That staleness repair is the real prerequisite for the remaining roots**
— take it up with fresh context; the WIP branch has the working
synthesis-layer changes and the ::-check skip (stash) to rebase on top.

**PINPOINTED (instrumented build, `YO_DEBUG_DISPATCH=1`):** the trait
branch's trial binds `self` to a FRESH `G` instantiation minted by
`_substitute_self_in_method_ty` (recv id 5094 ≠ the impl pattern 3377),
and `try_match_generic_impl(len's pattern 3170, recv 5094)` dies INSIDE
`synthesize_types` (a `[tm-try]` with no `[tm-end]` = the synthesis
exception fired) — unifying the pattern's `?*(T_len)` against the
substituted copy's `?*(T_clone)` structure throws where TS unifies. So
root #3 is a `types/synthesize.yo` SomeT-vs-SomeT gap, NOT a dispatch
ranking problem. The direct branch never mints the substituted copy (no
expected type), so its receiver IS the pattern instantiation and synthesis
succeeds. Debug hooks left in-tree: `[dispatch-miss]` (env.yo,
YO_DEBUG_DISPATCH), `[tm-try]/[tm-none]/[tm-end]` (impl.yo, same var),
`[abstract-spec]` (function.yo, YO_DEBUG_SWALLOW).

### B. Impl-level VALUE binder bound as a TYPE (#4, #5, #6)

```rust
impl(
  generic(T : Type, N : usize),
  Array(T, N),
  slice_copy : (fn(self : Array(T, N), r : Range(usize)) -> ArrayList(T))({
    e := cond((r.end > N) => N, true => r.end);
```

`usize` vs **`Type`** means `N` is bound as a TYPE. Same kind-correctness bug the
fn-level fix just cured, one level up: these are IMPL-level binders, a different
list from the fn's `forall_labels`, so the new binding does not reach them.

**Site LOCATED — `evaluator/values/impl.yo:2331-2349`.** Every impl binder is
bound as a type, unconditionally:

```rust
some_ty := t_some_t(param_name_str.clone(), frame_lvl);
tv := create_type_value(some_ty);
add_variable_to_env(forall_env, param_name_str, t_type(), .Some(tv), ...)
```

The annotation's right-hand side is parsed for the NAME and then discarded, so
`N : usize` becomes a `TypeVal` exactly like `T : Type`.

Also ruled out along the way: `evaluator/types/function.yo:1774` IS kind-guarded
(`is_type_0` → TypeVal, else `create_unknown_val`) and is the fn-parameter path;
`:2283` is unguarded but sits in `parse_where_clause_constraints`, whose subject
is always a type, so unconditional is correct there.

### The obvious fix is REFUTED — measured twice (2026-08-13)

Binding a value binder to `create_unknown_val(<declared type>)` instead — the
fn-level fix's exact shape — **breaks 87 of 247 files**, all with
`Cannot destructure from a module that is still being evaluated (circular
import)`.

Two attempts, isolating the cause:

1. Reading the annotation with `evaluate_expression_raw` → 86 circular-import
   failures. Plausible cause: impls are evaluated WHILE the prelude module is
   still evaluating, so evaluating anything there re-enters module evaluation.
2. Reading it with a PURE `find_variable_in_env` lookup instead — no evaluation
   at all → **the same 86 failures**. So the annotation lookup was never the
   problem: it is the BINDING itself.

Conclusion: the `TypeVal(SomeT)` binding is **load-bearing for evaluating the
impl's receiver pattern** (`Array(T, N)`), which runs in this same `forall_env`.
A value binder cannot simply be re-kinded there.

### FOUR measured attempts, all reverted — read before trying a fifth

`check ./yo-self` (~3 min, no build needed) was the gate for each. Baseline 247/247.

| #   | attempt                                                                                                                | result      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | re-kind the impl env binding; read the annotation with `evaluate_expression_raw`                                       | **160/247** |
| 2   | same, but read it with a PURE `find_variable_in_env` (no evaluation)                                                   | **160/247** |
| 3   | leave the env binding alone; register the kind, resolving the annotation via `get_variables_from_env` during impl eval | **160/247** |
| 4   | register the kind NAME only (purely syntactic, zero resolution), resolve it later in `_build_def_time_body_env`        | **238/247** |

Isolated sub-results, each measured separately:

- The `creators.yo` side table alone: **247/247** — harmless.
- Adding `register_some_binder_kind` to `impl.yo`'s existing `creators.yo`
  destructure, with NO code using it: **247/247** — so the added import is not
  the problem either.
- Attempt 3's code block, differing from attempt 4 only by resolving the
  annotation at impl-eval time: 160/247. **So a lookup during impl evaluation is
  itself unsafe** — `get_variables_from_env` can trigger lazy module resolution.
- Attempt 4 fails only 9 files, and they are the import-cycle-heavy ones:
  `main.yo`, `evaluator/index.yo`, `build_runner.yo`, `doc_command.yo`,
  `fetch_command.yo`, `macro_expand.yo`, `closure_type.yo`, `recur.yo`,
  `anonymous_function.yo`.

Every failure mode is the same error: **"Cannot destructure from a module that is
still being evaluated (circular import). The requested fields are not yet
available."**

### What that actually says about the codebase

yo-self's circular-import handling is **order-sensitive**: a module mid-cycle can
only be destructured for fields already evaluated. So ANY change that perturbs
evaluation order in this path — even re-kinding one variable in a body env —
re-orders enough to break a partially-evaluated destructure. That is why this
whole family resists otherwise-correct fixes, and it is the real blocker, not the
kind correction itself.

A fifth attempt should therefore NOT try another place to re-kind. It should
either

- make the binder kind available WITHOUT touching evaluation order at all (e.g.
  carried on the FuncVal at method-registration time, read only by the body-env
  builder), or
- fix the order-sensitivity first, so the module system tolerates a
  destructure of a not-yet-evaluated field (that is the deeper bug, and it would
  also de-risk every other def-eval fix).

`t_some_t_with_kind` was considered and rejected as the carrier: its field is
documented as the HKT kind and "must be a `Func` TypeValue", so putting `usize`
there would make a length binder look like a higher-kinded variable to the
TypeApplication paths.

## Method notes

- **Never guess a root; measure it.** Three hypotheses were refuted by
  measurement this session (a missing specialization, the
  `other_fn_call.yo:1805` producer, `Self`-typed params) — and one prediction
  that binding `N` would also clear family B above was wrong.
- **Kind matters in both directions.** A value binder bound to a `TypeVal` is
  the `usize`-vs-`Type` misbind of
  `issues/yo-self-collections-batch-residuals.md`; a type binder bound to
  `create_unknown_val(Type)` throws "expected type for element" because
  yo-self's TypeValues are snapshots and a placeholder must BE a type.
- **Every root gets the full battery.** This area's history
  (`issues/retired/yo-self-hollow-test-batch-main.md`) is a catalogue of fixes
  that cleared a repro and regressed another gate — including one that passed
  every gate while adding 13 hollow markers to the self-compile.
- Re-test the fatal `_trial_eval_fn_body` after each root falls; it is the
  definitive check that the swallow has stopped being load-bearing.
