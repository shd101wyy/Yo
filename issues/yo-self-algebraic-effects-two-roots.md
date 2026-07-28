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
