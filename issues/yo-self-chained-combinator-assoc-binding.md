# yo-self: 3-deep chained combinators — repeat trait checks lose the `Item := A` binding

State as of 2026-08-03 (the closure-F fix stack landed). This is the ONLY
root left behind `tests/iterator_combinators.test.yo` (arms 16, 17, 18 —
each hollows its batch standalone); arms 0–15 are real.

## Repro

`/tmp/m16.yo` shape (standalone, 2 markers):

```rust
n := my_range(i32(0), i32(100)).skip(usize(20)).take(usize(15)).count();
```

- `skip(20).count()` (2-deep) WORKS; `skip(20).take(15).next()` (3-deep,
  pattern-scoped method) WORKS; 3-deep + a BARE-`I`-blanket method
  (`count`/`any`/`fold`) fails: the method call types `unit` (soft
  fallback) and everything after it FTTs.

## Measured mechanism (probe log, m16p6)

`validate_where_constraints_for_call` → `IterTake(IterSkip(MyRange)) <:
Iterator` (full check):

1. FIRST check: step 8 → `try_match_generic_impl` on the bare-`I` blanket →
   where-pass binds `A` via the full check → **result=true** (probe W).
2. LATER checks of the SAME pair: `try_match_generic_impl` leaves forall
   **`A` unbound** (probe P2 `unbound forall=A`) → `all_bound=false` → no
   match → **result=false**.

So the first success registers/derives state (marker registry /
type-trait-methods) that makes REPEAT checks take a short-circuit path
which satisfies the enforcement but does NOT re-bind the impl's `A`
(`Iterator(Item := A)`), and the binding extraction in the where-pass
comes back empty. The step-4 registered path DOES run
`_check_associated_type_constraints` — the gap is between its
resolution channels for the just-registered nested record (the
`find_associated_type_from_generic_impls` recursion on the 3-deep record).

## Two fixes already landed in this area (keep!)

- trait_checking.yo guard key: `type_key(target)` (was `""` for structs —
  every struct-vs-trait check shared one key; nested same-trait checks
  self-collided). This alone flipped the FIRST check to true.
- The closure-F stack (see issues/fixed/yo-self-closure-f-identity-split.md).

## Next step for whoever picks this up

Probe `_check_associated_type_constraints(2939, Iterator(Item := A))` on the
repeat path: which channel resolves `Item` for the nested record on run 1
but not on runs 2–3, and whether the FIRST run's on-demand registration
writes an entry that makes `find_associated_type_from_generic_imples`'
recursion hit the recursion guard. TS never faces this: its
typeImplementsTrait memo returns the FULL result (bindings included) —
consider registering the resolved `Item` in the type-trait-methods registry
alongside the marker at first success, so repeat checks resolve it from
step 1 of the assoc check.

Canaries for this work: iterator_combinators arms 16/17/18 subsets
(`python3 scratchpad/subset_arms.py tests/iterator_combinators.test.yo 16 …`),
plus the full TIER 1 battery (the trait-check guard is global).

---

## 2026-08-03 UPDATE — arms 16/17 FIXED (17a8192ae); arm 18's root isolated

Arms 16 and 17 flip via (a) the pure-id trait-check guard key
(`_type_id_for_trait_check`, NOT type_key — type_key registers
g_struct_cfid_keys entries and poisoned the imm family's C identities) and
(b) DURABLE assoc-type registration at tmgi success + a registry-first
third forall-recovery channel in the bindings loop.

**Arm 18 (still hollow) is a DIFFERENT root** — a name-keyed forall
resolution leak between sibling blanket methods:
`.filter(p => …).fold(0, (acc, x) => …)` — fold's closure receives
FILTER's `F : (Fn(*(i32)) -> bool)` as its expected type
("Anonymous function: expected 1 regular parameters, got 2").
Probe-measured chain hops (env_lookup `_do_chain_resolve`):
`F 1204 -> 1250` and `F 1272 -> 1250` — fold's/other Fs name-resolve to
FILTER's F(1250), whose `F := TypeVal(F-1250)` binding sits in a frame
that stays visible to the SIBLING call's param resolution (in one hop the
env had nvars=1 — ONLY filter's binding visible, i.e. a PERSISTENT shared
frame, not fold's own callee frame). yo-self's ownership check
(`_was_self_bound`) passes because fold's F WAS self-bound elsewhere, and
the LAST-binding-wins name lookup picks the leaked entry. TS never faces
it: per-call forall freshening (helper.ts:1047) makes the callee's own
binding the last one.

Next step: find which write puts filter's `F := TypeVal(F)` into the
persistent frame (Step-6 synthesis add_variable_to_env frame targeting, or
the where-pass adapter's env.frames swap), and scope it to the call frame —
the same class as the "call-scoped rebinds (67acb7390) + lineage-identity
gate (92b27f68b)" fixes.

---

## 2026-08-03 late: the SAME leak blocks async_await arm-65 layer 4

Binding io.await's `E := <bundle>` per call — even as a PURE
`add_variable_to_env` into the callee env, no cell contact — leaks into
later name-keyed renders of the Io struct's member types during the STAGE-2
self-compile and aborts emission (three variants measured; see
issues/yo-self-io-await-shared-wrapper-poisoning.md). Fixing this
env-frame-sharing leak (call-scoped frames, or TS-style per-call forall
freshening — helper.ts:1047) unlocks BOTH arm 18 and arm-65 layer 4. It is
now the single highest-leverage remaining root.

---

## 2026-08-03 final round — the leak mechanism fully characterized; 4 fix candidates measured

Frame-topology probes (`[fadd]`/`[fleak]`/`[fw]`, env-var-gated) localized
the arm-18 leak precisely:

1. **The name-keyed resolution reads MULTIPLE same-named `F` bindings in one
   frame** — e.g. one 2-frame env whose frame 1 held `[F-1250(filter),
F-1272(take), F-1250]`; last-binding-wins picks a sibling call's F.
2. **A confirmed importer**: helper.yo's Step-6 "self-bound marker" loop
   (`sig_some_types := get_all_some_types(func_type)`) — a partially
   resolved METHOD signature carries `Self := <the receiver's combinator
record>` which EMBEDS the previous combinator's `F` in its type
   arguments; the loop then marker-binds that foreign SomeT under the shared
   name "F" into the callee env, shadowing the callee's own forall.

Fix candidates MEASURED (all reverted — none flipped the arm; keep for the
next design round):

- `evaluate_function_type` frame-scoping (push/pop around the fn-type
  eval's param/where writes, TS-chain parity): no effect on the arm; the
  imports happen at CALL time, not type-eval time.
- Level-gated name-collision follow in `_do_chain_resolve` (only follow a
  different-id binding at/above the querier's own self-binding frame): the
  leaked bindings live at the SAME frame level in reused/shared frames, so
  the gate can't separate them.
- Marker gate "forall-named markers only for ids in `forall_types`":
  BROKE legitimate freshened-id markers (arm-18 markers 1→8).
- Marker gate "skip SomeTs appearing ONLY in the self slot": no
  regression, but the arm still hollows — the poisoned binding reaches the
  resolution through at least one more channel.

**Conclusion:** the correct fix is architectural — TS-style PER-CALL FORALL
FRESHENING (helper.ts:1047: every call rebinds the signature's SomeTs as
fresh objects, so a name lookup can never land on a sibling call's
binding), or an immutable/chained env equivalent. Point solutions at
individual writers/readers keep failing because the same-name collision is
systemic. This root blocks: iterator_combinators arm 18, async arm-65
layer 4 (the E binding), and plausibly the batch-context Ctx collisions
behind async_await's remaining arms.

## 2026-08-03 addendum — generalized per-call forall freshening: built, measured ZERO wins, reverted

The TS helper.ts:1047 twin was implemented at BOTH call paths
(`_freshen_callee_foralls` at helper try_to_call entry + the inline FuncVal
arm's signature reads in calls/function.yo): fresh ids + empty cells,
name/level-preserving substitution through the signature. Measured: the
closure-F repro suite stays green (non-regressive), but arm 18 is
UNCHANGED — freshening fixes id-keyed collisions, while the leak crosses
the NAME-keyed `_do_chain_resolve`: the fresh `F` gets marker-self-bound in
the callee frame (Step 6), which satisfies `_was_self_bound`, and the
last-binding-wins name lookup can still land on a sibling's `F` whenever
the resolution runs against an env whose innermost `F` is the leaked one.
TS is immune because its resolution operates over per-call OBJECT
identities in chained envs — the callee's own binding is innermost by
construction.

**Terminal conclusion:** the fix is the binding-model redesign (chained /
call-scoped envs, or object-identity-verified resolution end-to-end), not
any per-site patch. Five fix families have now been measured against this
root (frame-scoping, level gate, two marker gates, generalized
freshening); all reverted with measurements above.
