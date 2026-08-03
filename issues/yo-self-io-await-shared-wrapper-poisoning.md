# yo-self: async_await arm 65 layer 3 — io.await's `fut` param resolves to the closure's Fn type

State as of 2026-08-03. Two compat-layer fixes LANDED (see below) moved the
arm-65 failure from the `(task : Impl(Future(i32, Ctx)))` BINDING to the
`io.await(task, ctx)` CALL — the previously-documented "io.await drop" is in
fact this eval throw, swallowed at def time:

```
Type mismatch for parameter "fut":
- Expected: fn(e : Ctx) -> i32
- Got     : Impl : (Future[Future](i32) Ctx : Ctx)
```

## Landed this round (types/compatibility.yo — keep)

1. Future effect matching compares TYPES only (TS compatibility.ts:516-529
   never reads labels) — a declared `Impl(Future(i32, Ctx))` (label "Ctx")
   now accepts io.async's return (declared effect forall label "E").
2. `_wrapper_carrier_args_concrete`'s Future arm gates on TOP-LEVEL
   SomeT-ness after `_resolve_cell_chain` (a concrete effect bundle
   NECESSARILY contains nested SomeTs — its ctl members carry ResumeType).
3. `_resolve_cell_chain` helper + effect comparison resolves both sides
   through resolution cells before recursion.

## The remaining mechanism (diagnosed, not fixed)

`io.await`'s declared param `fut : Impl(Future(T, E))` and `io.async`'s
declared RETURN `Impl(Future(T, E))` come from the same Io declaration —
ONE wrapper SomeT lineage. `_freshen_io_builtin_callee` (per-call
freshening) rebuilds only the FORALLS (T, E); `substitute()` rebuilds the
wrapper around the fresh T/E but COPIES the resolution-cell handle
(types/substitution.yo:255 — shared lineage by design). The io.async call's
return-type stamping bridge ("stamp the call result's resolved-concrete from
the callee BODY's def-time type", calls/function.yo) then writes the
CLOSURE's Fn type (`fn(e : Ctx) -> i32`) into that shared cell — and the
LATER io.await call's param re-eval resolves `fut` through the same cell to
the Fn type instead of the Future wrapper.

## Fix directions (pick after measuring against the io_async corpus, 12 files)

- (d, contained) At the param-vs-arg check: never adopt a param-wrapper
  resolution that CONTRADICTS the wrapper's own required traits (a
  Future-constrained wrapper resolving to a bare Func is self-evidently a
  poisoned lineage — fall back to the raw wrapper + structural check).
- (a, structural) Freshen the WRAPPER SomeT (fresh id + fresh cell) in
  `_freshen_io_builtin_callee`, and apply the freshening to io.await
  callees too. Riskier: the async pipeline registers the sync-future struct
  and io.await refinement against wrapper/output SomeT ids (see the Step-6b
  comment in calls/helper.yo for which ids must stay stable).

Repro: `tmp/a65/a65.test.yo` (single-arm extraction of async_await arm 65);
measure with the batch-marker method, never rc.

---

## 2026-08-03 UPDATE — layers 3 and 5 fixed; layer 4 BLOCKED on the env-frame-sharing leak

Landed on top of the two compat fixes above:

3. **Poisoned-lineage guard** (types/function.yo `_resolve_some_types_deep`):
   a wrapper whose OWN required traits include Future never ADOPTS a bare-Fn
   resolution — but resolution CONTINUES with the raw wrapper as the base so
   the nested-substitution path still rebuilds it from env-bound carrier
   SomeTs. (First version returned early and skipped the rebuild — measured.)
4. ~~Single-effect direct synthesis~~ — **REVERTED after stage-2 A/B**.
   THREE variants were built and each measured to ABORT the stage-2
   self-emit with `get_type_string: no C type name found for IoExn`:
   (a) globally in `_synthesize_future_traits`; (b) scoped to io-builtin
   call args (`skip_expected_type`) via `synthesize_types`; (c) the same
   scope via a PURE `add_variable_to_env` binding of `E` (no resolution-cell
   contact). Even (c) breaks: the callee env's FRAMES are shared with
   persistent envs, so the per-call `E := IoExn` binding leaks into later
   name-keyed renders of the Io struct's member types, minting an
   instantiation key mid-emission that collection never registered. This is
   the SAME env-frame-sharing leak as iterator_combinators arm 18's sibling
   `F` (issues/yo-self-chained-combinator-assoc-binding.md) — layer 4 is
   BLOCKED until call-frame bindings stop leaking into shared frames (or
   per-call forall freshening lands, TS helper.ts:1047). The mechanism
   itself is proven: with any variant in place the arm-65 extraction is
   GREEN (0 markers, 1 passed).
5. **Generic-fn-type check defer + all-paths-unwind relaxation**
   (expr_traversal.yo `all_paths_unwind` port; binding.yo
   `set_defer_generic_fn_type_check`; assignment.yo deferred recheck —
   TS binding.ts:160 / assignment.ts:438-470 / expr-traversal.ts:116):
   `(raise : Raise) = ((msg) -> { …; unwind(()); })` with
   `Raise :: (ctl(generic(T), …) -> T)` is accepted when the handler body
   provably always unwinds.

## Remaining

- **Layer 4** (the `E` binding): blocked as described above; the env-leak
  fix unlocks BOTH this and iterator_combinators arm 18.
- After layer 4, the next observed layer was a def-time
  `Cannot unify incompatible struct types: "Ctx" and <struct:…>` (per-arm
  local `Ctx` structs in the batch context) — bisect with `subset_arms.py`
  - `YO_DEBUG_SWALLOW=1`.

---

## 2026-08-03 re-measurement — layer 4 STILL aborts stage-2 under the arm-18 fix stack

After the six-layer arm-18 fix landed (env_lookup fast-path, Step-6
self-slot exclusion, foreign-forall search skips, synthesizer self-marker
shadow-add skip, \_bake_record_slots, durable 6c assoc binding — commit
"flip iterator_combinators arm 18"), variant (a) was re-applied and
re-measured: the arm-65 extraction stays GREEN (0 markers), but the
stage-2 self-emit STILL aborts with the identical
`get_type_string: no C type name found for IoExn` (emit rc=134,
current_function=yo_id_748823). Conclusion: the E-binding leak is a
DIFFERENT channel from arm 18's sibling-forall burial — the fix stack
disciplines eval-time name-keyed resolution, while this leak surfaces at
LOWERING: a later render of the Io struct's member types resolves the
shared `E` to the leaked IoExn and mints an instantiation key the
collection pass never registered. Next tool: the arm-18 probe playbook
pointed at stage-2 — writer probes on `E`/IoExn bindings plus a probe in
get_type_string's missing-key path to identify the rendering function and
the env/cell the resolution crosses. Candidate fixes once located: bake
the Io member types' effect slot at eval time (the \_bake_record_slots
pattern applied to the effect wrapper), or make the collection pass visit
the concrete `Future(unit, IoExn)` instantiation that the E binding makes
reachable.

## 2026-08-03 last round — two more containments measured, root sharpened to LAZY-EMISSION SPEC MINT

Two bounded fixes built and measured against the stage-2 gate, both aborting
identically (emit rc=134, "no C type name found for IoExn"), both reverted:

1. **opts=None on the single-effect synthesis** (no resolved-concrete cell/
   registry stamping; pure env binding — the (c)-equivalent re-measured on
   the current tree): still aborts. The drift is NOT through the shared
   per-lineage cell.
2. **Layout-faithful structural keys** (type_key's never-registered-sid
   structural fallback keying RUNTIME fields only): still aborts — the Io
   effect struct's fn-typed members ARE its runtime fields; the drift is in
   their RENDERS (a rebuilt IoExn instance with `E := IoExn` substituted
   into member fn types).

Sharpened mechanism: `current_function=yo_id_749xxx` is a specialization
minted DURING C emission (lazy call-site spec) whose param/local types hold
the REBUILT IoExn instance — collection ran before this spec existed, so no
key registration can ever precede the lookup. The abort is therefore
structural: **E-binding → downstream member-type rebuild → lazily-minted
spec at emission → uncollected key**.

Fix directions for the next session, in order of principle:

- **Collection-time pre-specialization**: make the collection pass force the
  specs that emission will lazily mint (TS collects after full evaluation,
  so nothing mints late there).
- **On-demand collection**: let `_lookup_named_c_type`'s miss path COLLECT
  the type (register key + emit typedef into the pre-pass buffer) instead of
  panicking — the emitters are split-buffered, so a late typedef has a home.
- Era-stable nominal keys need a genericity side-table (a bare
  `struct_decl_` sid cannot be keyed id-only: Bucket(K,V) instances share
  the decl sid with genuinely different layouts).

## 2026-08-03 final round — the stage-2 ABORT is SOLVED in principle (emit rc=0 achieved); 12 marker deltas remain

The on-demand collection direction was implemented and measured:

- **Hook**: `set_on_demand_declare_fn` in codegen/utils/index.yo —
  `_lookup_named_c_type`'s miss path calls it and retries before panicking.
- **Recovery** (codegen_c.yo `_on_demand_collect_and_declare`), two tiers:
  1. NOMINAL ALIAS: when exactly ONE registered entry shares the late
     type's nominal id, `register_type_alias(drifted_key, existing_key)` —
     no new C type (a fresh mint SPLIT the identity: "initializing
     **yo_t906 with **yo_t111"). Multi-entry sids (Bucket-style shared-id
     generics) fall through.
  2. FRESH MINT: collect_type + forward typedef + body appended to the
     DECLARATIONS buffer (three-buffer emitter ⇒ lands before all code).
     Known hazard: a nested miss DURING a body emit interleaves lines —
     tier 1 handles the common case before this matters.

Measured with the arm-65 E-binding (opts=None variant) applied:
**emit rc=134 → rc=0** — the "no C type name found for IoExn" abort is
fully recovered. Remaining gap: markers 25 (baseline 13) and clang errors
17 (baseline 4) — the E-binding perturbs ~12 further emission sites in
yo-self's own async code, each a separate delta to chase. Both pieces
REVERTED per the zero-net-wins discipline (the arm-65 flip isn't landable
until the deltas are closed), but the abort mechanism is now UNDERSTOOD
AND DEFEATED — the next session starts from "diff the 12 extra markers
under the E-binding + recovery", not from the abort.

## 2026-08-03 endgame — arm 65 is ONE landable step away; the exact remaining state

Landed groundwork (commit "four async-emission groundwork fixes"): on-demand
late-type collection with nominal aliasing, sync-setter SM-var clearing,
resolvable-wrapper skip exemption, future-wrapper param bridge.

**Variant (e) of the E-binding is the WINNING shape** (cell-only write into
the per-call FRESHENED effect forall — never an env binding, never opts
pass-through):

```
// in _synthesize_future_traits, after _synthesize_implicit_params:
if((exp_et.len() == 1) && (giv_et.len() == 1), {
  sfe_exp/sfe_giv := the two effect types;
  if(is_some_type(sfe_exp) && !(is_some_type(sfe_giv)), {
    <write sfe_giv into sfe_exp's resolved_concrete cell (clear+push)>
  });
});
```

Measured with variant (e) + the landed groundwork: arm-65 extraction GREEN;
stage-2 emit rc=0, markers=13 = BASELINE, clang=4 = baseline; TIER-1 all
green EXCEPT async_await itself, which UN-HOLLOWS to exactly TWO real
markers, both `test_unwind(task, io)` (arm 72, "Test unwind in async
closure") — the second one sits in initializer position and breaks the C,
so the file lands rc=1 and the precedent forbids leaving it hard-failing.

**Arm 72's remaining root** (the only thing between here and 185/0/0):
`test_unwind :: (fn(task : Impl(Future(i32, Ctx)), my_io : Io) -> ...)` is
still SKIPPED by should_skip_function_codegen as generic — pieces 3+4 did
not connect: the skip's param check (probably via the SPEC's registered
type, whose wrapper is a fresh/other SomeT id than the one piece 4
registered, or the skip runs on the ORIGINAL whose declared wrapper id
differs from decl_pt at spec time). Debug next: probe should_skip for the
fn (print param SomeT id + cell len + registry hit), then align piece 4's
registration key with whatever id the registered spec type actually
carries. TS control: ./yo-cli test /tmp/az72a.test.yo passes (repros:
/tmp/az72.test.yo = arm 72 full, az72a/az72b = single blocks; the
non-generic-Raise variant SIGSEGVs yo-self — separate latent issue, note
it, don't chase it first).
