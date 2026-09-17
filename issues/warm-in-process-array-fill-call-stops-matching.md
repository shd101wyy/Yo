# Warm in-process round: `Array(u8, N).fill(literal)` stops matching mid-round

**Status:** OPEN. Found 2026-09-17, the moment the warm Self-mismatch fix
(issues/warm-compile-selfcheck.md, RESOLVED section) let a `build --watch`
round get past `std/string` for the first time. This is the NEW last blocker
for the in-process artifact compile (§7 step 2,
plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md).

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
