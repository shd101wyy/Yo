# The `g_some_resolved_concrete` retirement is blocked: `some_resolution`'s registry fallback is load-bearing for codegen's SomeT lowering

**Status:** OPEN (blocker for Phase 3 step 7 part 2, branch `tss/p37-registry`; CORRECTED 2026-09-27 — see the update at the bottom)
**Found:** 2026-09-27, building the branch for the first time (it had been written unbuilt).
**Repro (corrected):** `tests/async/channel.test.yo` — the `Stream` combinators test (`ch.filter(...).map(...)`) fails E0905 at `std/async/stream.yo:141`

## Symptom

**CORRECTION 2026-09-27 (second build session):** the `Array.fill` FATAL below was
an artifact of MY probe edits, not the branch — a clean rebuild of the parked tip
(`b9ae26fe8`) checks `Array(i32, 4).fill(i32(7))` GREEN. The REAL, reproduced-on-clean
blocker is narrower: `tests/async/channel.test.yo` (the Stream combinators test,
`ch.filter(x => ((x % i32(2)) == i32(1))).map(x => (x * i32(10)))`) fails with

```
error[E0905]: This `io.async` closure's body was never fully evaluated
    --> std/async/stream.yo:141:29
```

and the swallow trace pins the owner: the trials run stream.yo:409 → 140 → 168,
then `[anon-swallow] error[E0601]: Cannot unify incompatible types: "bool" and
"i32"` — **`StreamFilter.next`'s spec-time body eval (stream.yo:168) fails
bool-vs-i32**: the filter's `A` (i32, the item type) meets the predicate's `bool`
somewhere it should not — a cross-closure/cross-slot pollutions between the
filter closure (`-> bool`) and the map closure (`-> i32`) that value-stamped
resolutions now route wrongly. `check ./std`/`check ./src` stay green
(176/176, 279/279); only the compiled compiler's async corpus breaks.
Start there: `closure_type.yo`'s value-stamping and the combinator spec mint.

---
Original write-up (the `Array.fill` part superseded by the correction above;
the registry/codegen-reader analysis stands):

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
