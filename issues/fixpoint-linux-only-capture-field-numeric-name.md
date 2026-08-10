# Fixpoint (Linux only): async capture field emitted as a raw numeric id

**Status: FIX LANDED, awaiting CI verification** (2026-08-10). The LAST red
CI arm on PR #92. The fixpoint HOLDS on macOS locally; on the Linux runner,
stage-2 emission fails clang with exactly 2 errors (both at one line):

```
/tmp/yo-stage2.c:2111829:20: error: assigning to '__yo_t0' ... from incompatible type '__yo_t1228'
  sm->result = sm->__capture.9087782;
```

(Previous head: line 1852226, same id `9087782` — stable across heads and
runs on Linux; the id never appears in macOS emissions.)

## Root cause

`resolve_var_name_in_context` (`yo-self/codegen/functions/context.yo`) scans
`state_machine_variables` for the first entry whose `cv.base.name` matches,
then built the field name **from the map key `k`** via
`get_state_machine_field_name(k, kind, aliases)`.

But the same outer capture is registered in that map TWICE:

1. under its **numeric variable id** — `combined.set(v.base.id.to_string(), v)`
   (`state_machine.yo:1100`), where the entry was re-kinded from Local to
   Outer by the capture-struct remap pass (`exprs/async.yo` "Re-kind captured
   variables that live in the capture struct as OUTER");
2. under its **capture-struct label** (`state_machine.yo:1126`,
   `combined.set(lbl, cv)`).

Which entry the name scan hits first is HashMap iteration order. On macOS
the label entry won everywhere (`__capture.<name>`, valid); on the Linux
runner one site hit the id entry first and emitted `__capture.9087782` —
the capture struct's field is the label, so clang rejects it. The order
differs by platform because the numeric id values differ (id allocation
shifts with the host), not because the module set differs — both
`runtime_io_linux.yo` and `runtime_io_macos.yo` are always in the closure
and target-switched at emit time; the earlier per-platform-module theory
in this file was wrong. Cross-target emit (`--target aarch64-linux-gnu`)
does not reproduce it for the same reason: the trigger is host-side id
allocation, not the target.

TS was never affected: `resolveVarNameInContext`
(`src/codegen/exprs/other-fn-call.ts:184`) emits
`__capture.${capturedVar.name}` for outer kind — the NAME, regardless of
which map entry the scan hits.

## Fix

Port the TS semantics: in `resolve_var_name_in_context`, the Outer arm now
emits `sm->__capture.${cv.base.name}`; the Local arm keeps
`get_state_machine_field_name(k, "local", aliases)`. This makes the result
independent of HashMap scan order, so it cannot diverge by platform.

## Test

No deterministic single-platform reproducer exists: the bug only fires when
the id-keyed entry hash-sorts ahead of the label-keyed one, which cannot be
forced from a `.yo` test. The detector is the CI fixpoint job itself (the
Linux stage-2 clang compile), which is gating.

## Related (still open, not this bug)

yo-self's resolver lacks TS's identity-based pre-resolution (the
`varExpr`/env-id path added for
`issues/fixed/async-sibling-arm-match-bindings-store-to-wrong-slot.md`).
If yo-self has no equivalent guard elsewhere, sibling match arms binding the
same name could store to the wrong slot under the self-hosted compiler —
worth a differential probe before P2.5.
