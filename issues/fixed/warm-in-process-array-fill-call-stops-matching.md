# Warm in-process round: `Array(u8, N).fill(literal)` stops matching mid-round

**Status:** FIXED 2026-09-17. Found the moment the warm Self-mismatch fix
(issues/warm-compile-selfcheck.md, RESOLVED section) let a `build --watch`
round get past `std/string` for the first time. The root cause was NOT the
fill machinery at all — see RESOLVED below.

## Symptom

With `YO_BUILD_IN_PROCESS=1`, `yo build --watch --poll-ms 300` on the probe
project (`/home/yiyiwang/Workspace/yo-watch-probe`), the round's first
artifact compile dies importing `std/string/string_builder.yo`:

```
error: No matching call found with arguments:
(Array(u8, usize(20)).fill)(u8(0))
    --> std/string/string_builder.yo:182:32
    |
182 |     buf := Array(u8, usize(20)).fill(u8(0));
```

`fill` is the prelude's value-generic inherent impl
(`impl(generic(T : Type, U : usize), where(T <: Comptime), Array(T, U),
fill : (fn(comptime(val) : T) -> comptime(Self))(...)`, std/prelude.yo:6868).
The argument is a LITERAL — this is NOT the comptime-trait-dispatch defect of
issues/array-fill-rejects-a-generic-dispatched-comptime-value.md (that one
needs `T.default()`); literals work there.

## The warm-order signature (measured, YO_DEBUG_DISPATCH=1)

The same call, in the SAME round, resolves fine the first time string_builder
is walked and fails in a later one:

```
# earlier in the same round — SUCCESS:
[fmg-cand] method=fill recv=Array(u8, 20) raw=fn(val : T : (Comptime)) -> Array(T, U) spec=fn(val : u8) -> Array(u8, 20)

# later in the same round — the candidate is STILL produced:
[fmg-cand] method=fill recv=Array(u8, 20) ... spec=fn(val : u8) -> Array(u8, 20)
[tm-synth-swallow] error: Cannot unify incompatible types: "ArrayList(T)" and "Array(u8, 20)"
... then the call site reports: No matching call found
```

So `find_methods_from_generic_impls` matches and mints the candidate both
times; the failure is DOWNSTREAM of the candidate — in the call-typing /
comptime-param machinery between the `[fmg-cand]` and the call site. The
`[tm-synth-swallow]` noise right after the failing candidate (ArrayList/Array
/ComptimeList patterns unified against `unit`) suggests the overload walk is
iterating impl entries against a DEGRADED receiver or expected type by then.

A cold child-process build of the same tree (`yo build` with no
YO_BUILD_IN_PROCESS) passes — the degradation is in shared-evaluator state
that only a warm/in-process round accumulates.

## Not caused by the Self fix (bisected)

The Self fix (a `Self` capture injected by `_inject_forall_captures` +
branch (b1) clearing ambient `ctx.self_type` in the spec path) was bisected
against this failure: with (b1) disabled via a temporary env gate, the round
dies EARLIER at the original ArrayList/String error and never reaches
string_builder; with (b1) enabled, every earlier error is gone and only this
fill failure remains. There is no configuration where the pre-fix code
reaches this call — it is EXPOSED, not caused.

## Leads (untested)

- The comptime-value specialization mint (`ou_spec_comptime_params`,
  function.yo — the machinery #725 instrumented and whose "specialization
  mint" lead was refuted for the COLD failure) is the first suspect for a
  warm-state memo keyed on state that a same-process earlier evaluation
  poisoned.
- `where(T <: Comptime)` validation at the call (`validate_where_constraints_
  for_call`) consulting trait-impl registries whose warm state differs from
  cold.
- The `[tm-synth-swallow]` unify-against-`unit` burst — find what walks impl
  entries against `unit` after the candidate is minted; that walk did not
  appear after the SUCCESSFUL earlier candidate.

## Repro

```
cd /home/yiyiwang/Workspace/yo-watch-probe
rm -rf yo-out
YO_BUILD_IN_PROCESS=1 YO_DEBUG_WARM=1 YO_DEBUG_DISPATCH=1 \
  <yo> build --watch --poll-ms 300    # fails ~2 min in, at string_builder.yo:182
```

## RESOLVED 2026-09-17 — the in-process compile never ran in watch mode at all

Instrumenting the no-match throw site (`[vcall-throw]`, YO_DEBUG_CTFE — the
callee resolved VALUELESS with `ty=unit`) and the property-access fallthrough
(`[pa-fallthrough] prop=fill obj_ty=Type`) traced the degrade to a SECOND
evaluation of the std/string chain inside one watch round:
`[warmcache] register` fired 26 times for 16 distinct modules. The module
cache is global and first-wins, so a second register means a full second
EVALUATION — and the re-evaluation (a fresh prelude env, but evaluator
registries surviving from pass 1) resolved `Array(u8, usize(20)).fill` to a
valueless callee.

The double evaluation was NOT a cache-coherence bug: the #728 skeleton's
in-process slot built the child argv but NEVER ADDED
`--compile-watch-mode`. `run_compile` therefore ran each artifact compile as
a plain COLD compile — `watch_mode=false` — so its
`if(!warm_reuse)` hygiene block fired `clear_module_cache()` +
`mm_clear_prelude_env()` + `stable_occurrence_reset()`, wiping the universe
the build-file evaluation had just populated. The compile then re-imported
and re-evaluated every std module from scratch (the 26 registers).

Fixes (this file's PR):

1. `build_runner.yo`'s in-process branch pushes `--compile-watch-mode` onto
   the filtered argv — the watch-mode contract (failure RETURNS, no mm_reset,
   no module-cache/prelude clears, shared ExprInfoTable) finally applies.
2. `main.yo`'s reset block additionally gates on `!(watch_mode)` (mirroring
   #728's mm_reset gating — this site was missed) and shares mm's
   ExprInfoTable under watch_mode (a fresh table would orphan the cached
   modules' node infos — their bodies are not re-evaluated on a cache hit —
   and codegen would emit FTT stubs).
3. `build_runner.yo`: a failed step's `exit(1)` is gated on the new
   `ExecutionContext.watch_round` — the watch loop's contract is that a
   failing round is REPORTED and the loop keeps polling; the hard exit killed
   the whole watch process on the first failed round.

With these, the round's exe compile advances past string_builder entirely and
the watch loop survives failures. The in-process path's next (and last known)
blocker is the long-documented one — warm struct-identity staleness with the
caches held: `Cannot unify incompatible struct types: "<struct:struct_r28c4_n50>"
and "ArrayList(u8)"` — item 1 of issues/warm-compile-selfcheck.md's
failure-modes list (the type-intern/SomeT identity tables outliving the
compile they were minted in). The un-gate of YO_BUILD_IN_PROCESS stays gated
on that fix.
