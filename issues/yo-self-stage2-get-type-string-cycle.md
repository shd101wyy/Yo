# yo-self stage-2: get_type_string SomeT-resolution cycle (SIGBUS) — guard landed; 4 dyn-capture cast errors remain

Found 2026-08-02 while running the mandatory stage2→stage3 fixpoint gate.

## The crash (FIXED by the guard)

Every stage-2 self-emit died rc=138 (SIGBUS, stack-guard
`KERN_PROTECTION_FAILURE`, "Could not determine thread index for stack guard
region") with millions of `get_type_string` self-frames under
`generate_function_prototype`. **PRE-EXISTING — proven by controls:**

| binary           | input tree     | result                                |
| ---------------- | -------------- | ------------------------------------- |
| 784b72ded binary | 784b72ded tree | rc=138                                |
| 10bca26bc binary | 10bca26bc tree | rc=138 (implied via +guard run below) |
| session binaries | any tree       | rc=138                                |

So the handoff's recorded `FIXPOINT_HOLDS` baseline was stale — the crash
predates this session (and predates `e40d924f4`). Memory pressure was ruled
out (reproduced with 10 GB free RAM, default and 4 GiB stacks).

Root: `get_type_string`'s `.SomeT` arm hops to the resolved concrete
(`recur(rct)`); a resolution CYCLE — a SomeT whose cell/global entry resolves
(directly or via a chain) back to a type containing the same SomeT — recursed
unboundedly. The cycle lives in the dyn(Fn) wrapper family (see below).

Fix landed: `g_gts_some_stack` cycle guard in `codegen/utils/index.yo` — a
revisited SomeT id demotes to the unresolved fallback (registered name /
`void*`), the same "bounded by a monotonic visited set" convention
`type_to_string` follows.

## The residual (OPEN): 4 dyn-capture cast errors

With the guard, stage-2 emits **hollow=0** but clang rejects the C with
exactly 4 errors of one shape:

```
operand of type '__yo_t885' (aka 'struct __yo_t885_struct') where arithmetic or pointer type is required
```

at calls to specialized `is_yo_dyn_Fn_AstExpr…` predicates, where a dyn(Fn)
CAPTURE STRUCT value (`capture_yo_id_283947`) is passed through a
`(void*)(get_info)` cast — the parameter's type rendered `void*` because its
SomeT resolution is exactly the cycle the guard now demotes.

**TS emits no `is_yo_dyn_*` functions at all** for the same input
(`grep -c is_yo_dyn /tmp/ts_stage1.c` = 0) — the whole specialized-predicate
family is a yo-self-only divergence (likely an unfolded `Type.impls`-style
dyn test that TS folds at compile time). Measured at three tree states
(current, 784b72ded, 10bca26bc — all +guard): identical 4 errors.

## Current gate state (honest)

- stage-2 emit: rc=0, hollow=0 ✓
- stage-2 clang: 4 pre-existing errors ✗ → stage-3/fixpoint unreachable
- The fix belongs to the dyn(Fn)-family resolution-cycle repair: either fold
  the dyn predicate at compile time like TS, or resolve the capture-struct
  parameter type without entering the cycle.
