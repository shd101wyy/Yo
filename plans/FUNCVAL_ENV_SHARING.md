# FuncVal env sharing (env-sharing campaign 2) — shared Variable handles in the capture rebuild

**DESIGN REVISED 2026-08-23.** The original mechanism below (§3: freeze a
multi-frame def-scope env per definition, registry-preferred at call time)
was BUILT AND REJECTED the same day, twice over — keep this record, the
failure modes generalize:

1. **Semantics.** The call machinery's frame-level arithmetic grew up against
   `capture_env_for`'s SINGLE-frame env shape. Multi-frame callee envs broke
   `(!)`/Call-tuple dispatch (`_Self : (LogicalNot)` refused to bind `bool` —
   the trial rejection surfaced as "No matching call found" at the prelude's
   `!=` default) and derive rules ("derive rule must return comptime(Expr);
   got Comptime"). A single-frame frozen env fixed both repros — the depth
   was the poison, not the sharing.
2. **Performance.** Freezing per DEFINITION (eagerly, fresh `index_key` per
   frame) thrashed `g_frame_indexes`' 2048-entry wholesale clear:
   `check src/env.yo` went 24.7 s → >9 min with 78% of CPU in `__yo_decr_rc`
   + TLS reads under the two env-lookup functions. `capture_env_for` never
   thrashed because it builds LAZILY at first call, memoised, bounding the
   number of distinct capture frames.
3. Also fixed en route: the frozen env carried the DEF module's
   `module_path` where the flat env stamps the CALLER's — relative-import
   resolution (`import("./rune.yo")`) flows through `env.module_path`, so
   def-module stamping mis-resolved sibling imports.

**The revision keeps `capture_env_for`'s laziness, per-instance memo, and env
shape untouched and changes exactly one thing: the definition site registers
the ORIGINAL `Variable` handles (`g_funcval_cap_vars`, keyed by a fresh
`FuncValData.env_key`), and the rebuild pushes those handles into the capture
frame instead of re-minting Variable + value cell + name string per binding.**
Semantic deltas vs the flat rebuild, accepted and gate-tested: captured
variables keep their true `is_compile_time_only` flags and live value cells
(the flat loop marked EVERYTHING comptime and used `VarRef` sentinels for
valueless bindings).

Measured (self-emit, M4): step 2 alone (direct definition sites only)
141.3 → 138.6 s / 17.19 → 16.53 GB footprint — the big population is DERIVED
FuncVals (step 3): today all 17 derived construction sites leave `env_key = 0`
and fall back to the flat rebuild, safely.

**Status: steps 2+3 (revised design) implemented and gate-green
(gates_fast failures=0, FIXPOINT_HOLDS, late_sibling 2/2, check ./src
260/260).** Step 3 wired the derived-FuncVal sites: verbatim-reuse sites
(_stamp_impl_forall_on_method, trait-default materialization x2,
_build_comptime_clone, fv_for_recur) pass `env_key` through;
binding-appending sites (create_specialized_function_inline,
create_ctl_specialized_function, _inject_forall_captures) inherit the
parent's handle list and append looked-up Variable handles or
`make_capture_variable` mints, registering under a fresh key — all guarded
to stay on the flat fallback when the parent never registered. Partial
application and the empty-capture placeholder sites deliberately stay at
`env_key = 0`.

Measured cumulative (self-emit, M4): 141.3 → 138.3 s wall,
17.19 → 16.08 GB footprint (−1.11 GB). Below the census ceiling — the
remaining flat-fallback population (attribution probe) is the step-4
follow-up, along with the endgame deletion of the flat triple lists.

Original design below kept for the record (its §1/§2 ground-truth research
and §6 risk checklist remain valid).** Successor to the landed §3 def-time
sharing (`plans/backlog/YO_SELF_ENV_SHARING.md`, `_share_def_time_frames`).
Target: the `capture_env_for` population — **242,154 rebuilds minting
144.5 M `Variable`s per self-emit (~597/rebuild), 99% from DERIVED FuncVal
creation** (specialization, impl shells, ctl-inline). Memo variants were built
twice and REFUTED twice (37 hits / 587 hits + 2.1 GB retention) — this
campaign is the only remaining lever for the site, and it is a SEMANTICS
change gated accordingly.

## 1. Ground truth (verified against the `src-attic-final` TS attic)

- TS keeps the definition scope on the **function type**: `FunctionType.env`
  (`src/types/definitions.ts:881-886`), set once at signature evaluation from
  the live env minus the params frame (`evaluator/types/function.ts:2643`).
  `FunctionValue` carries only `frameLevel`. There are ZERO flat capture
  lists on the TS value.
- Call time is one choke point: `calleeEnv = pushEnvFrame(functionType.env)`
  (`evaluator/calls/helper.ts:1141-1144`); Self/foralls/params are then bound
  into that env. Specialization/impl/ctl derivations INHERIT the env
  (`{...functionType, env: functionType.env}`) — they never rebuild scope.
- The env selection at definition is **three-way**: live env as-is (closures,
  `closure-type.ts:66`), live env as-is (module-level fns,
  `function-type.ts:298-304`), `keepTopLevelFrameAndComptimeVariablesFromEnv`
  (nested non-closures; frame 0 whole, other frames filtered to comptime-only
  — same Variable objects, never new ones).
- TS gets snapshot semantics FOR FREE: its `Environment` is persistent/COW
  (`addVariableToEnv`/`updateExistingVariable` build new frames). yo-self
  frames append IN PLACE, so every stored env must be FROZEN explicitly —
  the §3 rule: share `Variable` handles, rebuild every `Frame` (frame 0
  included) with a fresh variables list and a **fresh `index_key`**
  (`issues/env-sharing-live-frame-membership-leak.md`; the rule is stated in
  the backlog doc as binding on this campaign).
- Codegen does NOT read any of this: the C closure struct comes from the
  separate captured-variables analysis
  (`create_capture_type_and_value` → `register_closure_capture_info`),
  already ported. This campaign is evaluator-only.
- TS has no `__recur_fn`: `recur` resolves through the function-body
  evaluation CONTEXT (`context.ts:9-18`, `recur.ts:124-134`), and by-name
  recursion uses the enclosing declaration's forward-reference variable.
  yo-self's `__recur_fn` frame stays as-is for now (it is pushed onto the
  callee env AFTER the base env is built, so the mechanism is orthogonal);
  its visibility must simply not change.

## 2. The yo-self placement problem, and the decision

`Environment` cannot live on `FuncValData` or on yo's `FunctionType`:
env.yo imports value.yo (Variable holds EvalValue), and types/definitions.yo
sits below both. Forward references across top-level types are rejected
(probed 2026-08-22), so direct mutual recursion is out. Two candidates:

- **(A) Genericize the env types** (`EnvG(V)` in a leaf module;
  `EvalValue.FuncVal(..., env : EnvG(Self))` — the `ArrayList(Self)`
  precedent suggests it types). REJECTED for this campaign: it drags every
  definition in env.yo (and its ~50 importers' type identities) through a
  genericization purely to move a field, multiplying the id-reseed blast
  radius the §3 campaign already showed is the dangerous part.
- **(B) A def-env side table in env.yo**, keyed by a fresh per-construction
  id stored on `FuncValData`. CHOSEN. Precedent: `ExprInfo` is a side table
  for exactly this reason, and `src/function_value.yo` already keeps
  func-id-keyed registries (`g_closure_fid_source`,
  closure-capture info). Divergence from TS placement (value-side key vs
  type-side field) is recorded here deliberately: yo's call paths all have
  the FuncVal in hand at the moment TS reads `functionType.env`, and the
  mechanism being ported is "the frozen definition scope is reachable at
  call time", not the field's address.

Known hazards of a registry, addressed up front:
- *Key identity*: `func_id` is NOT unique per FuncValData (impl.yo:149 and
  :4004 reuse it with the same lists; `_inject_forall_captures` reuses it
  with new lists) — the registry key is a FRESH `env_key : usize` minted per
  construction that stores an env; `usize(0)` = absent.
- *Mis-port class* ("TS reads off the value, yo-self keys a global table"):
  during migration every registry MISS falls back to the existing
  `capture_env_for` flat rebuild, so a lost key degrades to today's
  behavior, never to `.None`-shaped wrongness. The fallback is removed only
  in the endgame, when creation sites are provably total.
- *Retention*: entries live for the process, like TS's `FunctionType.env`.
  Under sharing, a derived FuncVal's entry is one `Environment` shell +
  frames list (+ one pushed binding frame) — pointers, not Variables.
  Budget check in §5 measures it. Every frozen frame's `index_key` is
  tracked for `g_frame_indexes` eviction exactly as `capture_env_for` does
  today (`g_capture_env_index_keys` pattern).

## 3. Mechanism

New, in env.yo (alongside `capture_env_for`, which stays during migration):

```rust
// Frozen def-scope registry (TS: FunctionType.env).
(g_funcval_def_envs : HashMap(usize, Environment)) = ...;
(g_def_env_index_keys : ArrayList(usize)) = ...;   // g_frame_indexes eviction

// Freeze a LIVE env for capture: share Variable handles; rebuild every
// Frame (frame 0 included) with a fresh variables list, same frame id,
// shared where_clause_constraints, FRESH index_key.  (§3 pattern, hoisted
// out of function_type.yo so both campaigns share one implementation.)
freeze_env_for_capture :: (fn(env : Environment) -> Environment)(...);

register_funcval_def_env :: (fn(env_key : usize, frozen : Environment) -> unit)(...);
get_funcval_def_env :: (fn(env_key : usize) -> Option(Environment))(...);
// Derived FuncVals: snapshot the parent's FROZEN env (frames already
// immutable → sharing them outright is safe), push one binding frame.
extend_funcval_def_env :: (fn(parent_key : usize, bindings...) -> usize)(...);
```

`FuncValData` gains `(env_key : usize)` (last field; `derive(Clone)` shares
it — intended: TS clones share the env object).

Call-path change (function.yo:5029, helper.yo:4750, and the manual rebuild
loops at index_trait.yo:1227, ctfe_analysis.yo:160, function.yo:2927/6341,
helper.yo:3416): `match(get_funcval_def_env(fvd.env_key))` →
`.Some(fe) => snapshot_env(fe)` (+ push frames as today), `.None => ` the
existing flat rebuild. The callee then proceeds identically (param frame,
`__recur_fn` frame, foralls).

What the flat lists KEEP doing (unchanged this campaign): the
generic-binding channel — `_funcval_bind_foralls` (function.yo:1619),
`_inject_forall_captures` (impl.yo:1321), `_impl_type_captures_sig`
(helper.yo:1578) and the specialization-guard, the TypeVal appends at
helper.yo:3132/4070, codegen/functions/collection.yo:928. These read only
TypeVal/IntLit captures = "the impl/forall bindings stamped on this
FuncVal", which a scope reference does not distinguish. Shrinking those
lists to bindings-only is the endgame (§6), not this campaign.

## 4. Step plan (each step lands only through the full gate battery)

1. **Infra**: `env_key` field (default `usize(0)` at all 19 construction
   sites), `freeze_env_for_capture` (hoist/share with
   `_share_def_time_frames`'s core), registry + eviction accounting, the
   call-path fallback match (no keys registered yet → behaviorally inert;
   gates prove the plumbing is a no-op).
2. **Real definition sites** (the two snapshot loops): 
   `evaluate_anonymous_function` (anonymous_function.yo:942-982) and the
   `fn(...)`-type path (function_type.yo:1019-1100) mint `env_key` +
   register `freeze_env_for_capture(env-in-hand)` (matching TS's three-way
   selection: the filtered variant shares frame 0 and keeps
   comptime-only + module-level Variables elsewhere — same predicate as
   `_share_def_time_frames(strip=true)`). Flat lists still built (consumers
   + fallback). `has_fwd_comptime_fn_cap` stays with the loop.
3. **Derived sites inherit**: helper.yo:3173 / 4081, impl.yo:149 / 1413 /
   3957 / 4004, ctfe_analysis.yo:352, function.yo:4058 (partial app builds
   its 3-entry env directly), function.yo:5040 (`fv_for_recur` shares the
   callee's key). Each inherits the parent key or extends it with its
   binding frame via `extend_funcval_def_env`.
4. **Flip the call paths' preference** (they already prefer the registry
   from step 1) and measure: wall + peak footprint on the self-emit and on
   `check ./src`, attribution of remaining `capture_env_for` misses.
5. **Endgame** (separate PR): delete `capture_env_for` + memo + the two
   snapshot loops + the manual rebuild loops once misses are zero on the
   full corpus; shrink cap lists to the generic-binding channel.

## 5. Gates (every step)

- `yo check ./src --std-path ./std` and the language suite subset touching
  closures/impls/specialization; `tests/late_sibling_method_name_shadow.test.yo`
  explicitly.
- `S1=<bin> P=<tag> scripts/bootstrap/gates_fast.sh`;
  `scripts/bootstrap/fixpoint_only.sh` (stage-2 ≡ stage-3).
- **Emitted C**: steps 1-3 must be byte-identical to baseline (fallback in
  force = no behavior change). Step 4 is where the emit may legally shift
  (SomeT `pf_level` depth, id reseed) — gate with the corpus diff-test and
  the per-function dup/drop-count diff (fewer dups = potential UAF —
  memory rule), plus the hollow-sweep ratchet.
- Peak **footprint** (never RSS) on the self-emit; registry retention
  measured and recorded here.

## 6. Risk checklist (inherited from campaign 1 — binding)

1. Frozen membership: never store a live `Frame` handle; fresh `index_key`
   per rebuilt frame; eviction path for every long-lived index entry.
2. Never mutate a shared `Variable`; fixups = shadow bindings in a pushed
   frame.
3. `pf_level`/SomeT stamping deepens when the call path stops flattening
   (step 4) — corpus diff-test is the gate; `sig_some_ts` stays until gates
   (not reasoning) prove it redundant.
4. Id reseed re-exposes HashMap-iteration-order first-match bugs (two prior:
   `_find_bundle_var_field`, dup/drop) — re-audit on any new differential.
5. `__recur_fn` must not become visible through the shared env (the frozen
   rebuild excludes nothing, but `__recur_fn` is bound in a frame pushed
   AFTER capture at function.yo:5036 — verify with a lookup probe test).
6. Dup-accounting on runtime captures: the VarRef placeholders vanish from
   the callee env in step 4; the closure-capture C pipeline is separate, but
   the emit-diff + dup/drop gate is the proof, not this sentence.
