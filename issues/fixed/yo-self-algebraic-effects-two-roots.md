# yo-self algebraic_effects RED — two roots, one fixed in /tmp/yb

Minimal repros (2026-07-28): `/tmp/ae_a.yo` (generic struct-record ctl handler,
`exn.throw(x, i32(666))` resuming), `/tmp/ae_b.yo` (cee: regular `->` handler
capturing `outer_val`). TS: both green.

## Root A: type-erased evidence-call args not cast — FIXED in /tmp/yb (unlanded)

`((i32 (*)(i32, void*))exn.throw)(x, 666)` — int into `void*` slot. TS casts
EVERY arg to the fn-ptr cast's param type (other-fn-call.ts:1647-1656
castedArgsList). Ported to codegen/exprs/other_fn_call.yo's fn-ptr arm
(split args via \_split_top_level_args_list, cast each `(ty)(part)` when
counts match). VERIFIED: ae_a now compiles; TS-identical arg emission.

### Residual A2: handler body `return(resume_val)` FTTs

The emitted handler is `void* fn(...int32_t val, void* resume_val) {
// Failed to transpile return(resume_val); }` — TS emits `return resume_val;`
raw. So ae_a runs but resumes garbage (assert aborts rc=134). The FTT source
is upstream of return.yo's temp typing (probably the arg_code emission for
the SomeT-typed param atom) — probe next.

## Root B: cee-rejected handler still emitted (the half-registered-fn class)

The regular-fn-no-capture validation EXISTS and FIRES (probed: `outer_val
lvl=2 < outer=3` → throws; the cee catches it and PASSES). But the handler fn
was already REGISTERED before the check threw, codegen emits it, and its body
references the outer var → `use of undeclared identifier 'outer_val'`
(clang rc=1). Same class as the handoff's "impl flip" note: yo-self's mutable
registrations keep half-registered definitions that TS discards on throw.
FIX DIRECTION: at the capture-check throw site (anonymous_function.yo
\_check_anon_fn_captures caller), the fid is in scope — mark it
skip-for-codegen (needs a small fid side-table consulted by
should_skip_function_codegen, or reuse an existing "unemittable" mark if one
exists). Probes \_\_YCAP still in /tmp/yb — strip before landing.

## UPDATE: root B is deeper — the capture-check throw ESCAPES the cee

Probed (`__YTHROW` at the check's throw, `__YCATCH` at
`_comptime_expect_error_arg_threw`'s local exn, `__YCEE` at the cee tail):
for `/tmp/ae_b.yo` the throw fires ONCE, the cee's local exn NEVER catches,
and the cee tail is NEVER reached — the handler's anon-fn evaluation happens
on a pass whose threaded `exn` is the enclosing begin's (main's), NOT the
cee clone eval's. Result: the cee statement AND everything after it in main
abandon (`// Failed to transpile comptime_expect_error(...)` + dropped
`println`) — in the standalone repro main is EMPTY, so rc=0 was VACUOUS.

**LANDED-STATE WARNING**: `tests/codegen-bootstrap/cee_regular_fn_capture_reject.yo`
(landed in `91ff0327b`) therefore DIFFs on HEAD (missing stdout) — TIER 1's
corpus gate is RED on HEAD until this is fixed. The unemittable-mark half is
correct (C compiles); the throw-containment half is the open piece.

NEXT: find which pass evaluates the ctl-handler ctor field with the outer
exn (candidates: the effect-record registration path for ctl fields, a
struct-ctor arg eval that threads a stored/statement-level exn instead of
the propagated one, or main's def-time trial evaluating the cee arg OUTSIDE
`_comptime_expect_error_arg_threw`). Probes **YTHROW/**YCATCH/\_\_YCEE still
in /tmp/yb (with the ctl_force + propagate-mode gate — ctl_force verified
fixing ae_a end-to-end and algebraic_effects rc=0 with all 72 tests
running, markers 7 → 2).
