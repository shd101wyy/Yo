# The `g_some_resolved_concrete` retirement is blocked: `some_resolution`'s registry fallback is load-bearing for codegen's SomeT lowering

**Status:** OPEN (blocker for Phase 3 step 7 part 2, branch `tss/p37-registry`)
**Found:** 2026-09-27, building the branch for the first time (it had been written unbuilt).
**Repro:** `issues/repros/array-fill-spec-stays-hollow-under-p37.yo` — `Array(i32, 4).fill(i32(7))`

## Symptom

The branch passes `yo check ./std` (176/176) and `yo check ./src` (279/279), and its
compiled self-build succeeds — but programs that use a generic impl method whose
def-time trial legitimately swallowed fail:

```
arr := Array(i32, 4).fill(i32(7));      // yo check tmp/fixme.yo
yo: FATAL: reached fn_yo_id_17076690078229831711000000, whose body failed to
    transpile - its definition-time evaluation failed and was swallowed.
```

`fn_yo_id_1707…` is prelude's `Array(T, U).fill` (the `MaybeUninit` raw-pointer
body whose def-time trial with abstract `T` swallows "Cannot cast unit to
`*(T : (Comptime))`" — legitimate, both worlds). On develop the SPECIALIZATION
`fill(i32, 4)` re-evaluates the body concretely and everything works; on the
branch the spec stays hollow and the abort stub (or, on the async corpus,
`E0905` "never fully evaluated" at `std/async/stream.yo:141`) fires instead.

**The failure surface is order-dependent per binary** (the evaluator's
hash-iteration order): adding a single gated `eprintln` moved the same root
failure between the `fill` abort stub and the stream E0905 — bisect verdicts
from single builds are noise at the boundary; the commits between
`435d24547` (green build) and `c98c8843e`+ (red builds) are implicated as a
family, not individually.

## Root cause (diagnosed, probes in the session log)

1. **`some_resolution` on develop reads value-first-then-REGISTRY.** The branch
   made it value-only. But the registry fallback served ~37 readers — in
   particular CODEGEN's SomeT→concrete lowering (`get_type_string` via
   `some_resolution`, `codegen/utils/index.yo`), which the capbind/capture
   machinery depends on ("register the capture struct as the SomeT's resolved
   concrete so `get_type_string(SomeT)` lowers to it"). Value-only starves them.
2. **A value-scoped stamp does not cross eval generations.** TypeValues are
   copies; the copies a later eval generation reads (an `io.await` of a future
   that arrived through another specialization's result — `StreamMap.next`
   awaiting `self._inner.next(io)`; a spec re-check reading stored ExprInfo
   types) were taken before the call stamped its local. The id is the only thing
   every copy of one call's output shares. (A restore of the registry scoped to
   io.async's FRESH per-call output ids — no shared-id hazard — plus fallbacks
   at the four evaluator reader sites was attempted and did NOT fix the corpus:
   the remaining gap is the codegen readers in (1) and the three "(experiment)"
   writer deletions, whose entries those readers consumed.)
3. `Array.fill`'s spec mint never re-evaluates the body: the re-eval decision
   path consumes a resolution channel the branch changed (`values/impl.yo`'s
   forall-arg resolver, `types/function.yo`'s deep resolvers) — probes at
   `_bind_forall_from_type_args` and the deep-substitution adoption sites
   never fired for the minimal repro, so the exact consumer is still to be
   found (start: instrument the spec-mint skip decision for a def-swallowed
   generic-impl method).

## What unblocks it

Hand every id-only CODEGEN reader the SomeT VALUE (the census in the handover
§6 says which took only ids), or rebuild the resolution at every mint that
consumes it — one writer at a time, each verified under a BUILT compiler with
`Array.fill`'s repro plus the async corpus, because order-dependence hides
single-site breakage. The seven SHARED-id writer conversions in the branch are
believed sound; the io.async-output id is fresh-per-call and registry entries
under it have no last-write-wins hazard if the bridge must stay meanwhile.
