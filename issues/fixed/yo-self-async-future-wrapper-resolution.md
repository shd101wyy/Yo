# yo-self: async-future family — wrapper resolution chain ported (fs/\*, sys/bufio)

**Status: FIXED** (this commit). Flips 6 of the 8 async-future files at s1
level: fs/{file 13, dir 12, metadata 6, temp 7, fs_convenience 9}, sys/bufio
22 — all counts TS-identical. Remaining: fs/walker (rc=1, 1 passed —
different tail), sys/timer (needs the multi-await resumable-FSM lowering
port, tracked in `issues/yo-self-async-emission-cluster.md`).

## Symptom (the whole family)

Caller-side sync awaits on a returned `Impl(Future(T, E))` rendered the
GENERIC runtime future: `__sync_future` declared `__yo_io_future_t*` →
`no member '__yo_resume_fn'` / `->result` typed `int32_t`; plus
`conflicting types for 'yo_id_N'` — fn PROTOTYPES rendered
`__yo_io_future_t*` while DEFINITIONS rendered the concrete
`<block>_sync_fut_t*`.

Repro: /tmp/yo_async_repro.yo (write_file + read_file via std/fs/file,
`io.await`, byte-count assert). TS `ok 5`; s1 was 21 clang errors.

## The three stacked roots (all fixed)

1. **Call-time return stamp unported** (`function.ts:2080-2100`): when a
   called fn's declared return is a SomeType, TS stamps the CALL result with
   `resolvedConcreteType` = the callee BODY's def-time-evaluated type
   (one SomeT-with-rCT level unwrapped) via a per-call CLONE. This is the
   bridge that lets a caller's await site resolve through the returned
   wrapper to the callee's async block — the SM struct is registered under
   the async-block future's identity, which only the body's stamp carries.
   Port: `_evaluate_funcval_runtime_call` (calls/function.yo) now rebuilds
   `resolved_ret` via `_with_resolved_concrete` — same SomeT id, FRESH cell
   seeded with the body's stamped type (the value-semantics mirror of TS's
   `{ ...returnType, resolvedConcreteType }` spread; never mutates the
   declaration's shared lineage cell).

2. **Def-time return stamp unported** (`function-type.ts:613-631`): after a
   concrete fn's def-time body eval, TS stamps the declared-return SomeT's
   `resolvedConcreteType` from the body type (or propagates it from a
   delegation wrapper's resolved SomeT). Port: end of the non-deferred arm
   in `try_to_implement_function_by_function_type` (calls/function_type.yo)
   — stamps the lineage CELL (the declaration object's value-semantics
   surrogate) + the id-keyed `register_some_resolved_concrete` bridge.
   NOTE (probe-verified vs TS): at that point TS's `functionBodyReturnType`
   is usually the return SomeT ITSELF (`ret.id == bodyId` — the synthesizer
   already stamped it during body↔expected unification), so this block is a
   delegation-wrapper/direct-concrete fallback, not the primary stamp.

3. **Module fns wrongly marked effect-record members** (the
   prototype-vs-definition conflict): `collect_effect_record_members`
   (codegen/functions/collection.yo) marked every fn field of ANY StructVal.
   In TS the module record's fn fields are the SAME FunctionValue objects
   the regular collection already registered, so the
   `!context.functions[funcId]` guard no-ops — module fns are NEVER
   isEffectRecordMember in TS. yo-self re-evaluation mints per-reference
   FuncVal GENERATIONS with fresh func_ids, so the id-keyed guard missed and
   every fs/file convenience fn referenced through `fs_file.member(...)` got
   marked → declarations pass strips erm bodies (faithful TS strip) → the
   async return-type override never ran at declaration → generic prototype,
   concrete definition. TWO fixes:
   - `collect_effect_record_members` skips fn fields of module-namespace
     records (`ty_name.starts_with("source_namespace_")`, minted at
     evaluator/exprs/import.yo:230) while still recursing nested StructVals
     (module-level effect-handler records keep getting marked).
   - `find_function_calls_in_expr`'s dot-call branch registers a
     module-member callee REGULAR from the receiver's module StructVal by
     label (yo-self dot-access callee nodes carry no ExprInfo, so TS's
     callee-`$.value` registration had no mirror), guarded by
     has_function + !is_control_fn + !generic-unspecialized.

## Probe ledger (for archaeology)

- [DTSTAMP] (TS, temporary): every fs/file fn hit function-type.ts:613 with
  `ret.id == bodyId` — body type IS the return SomeT object; rCT already
  set (SomeType) for the direct-io.async fns → the operative TS stamp is
  the synthesizer's expected-SomeT bind (synthesizer.ts:463), which yo-self
  already mirrors (cell + registry, evaluator/types/synthesizer.yo:1305).
- [PREREG]/[OVR]/[DECL]/[DEFN]/[DECLVAL]: preregistration stamped all 15
  fs/file async blocks; `_async_override_return_type` resolved the SM
  struct for File METHODS but the 8 top-level convenience fns arrived with
  body=NONE at declaration (the erm strip) while their definitions carried
  the body → the conflicting-types pair.
- [ERM]/[SWALK]/[MODMEM]: the marking walk fired from the REPRO's own
  `fs_file` receiver atom (module record stamped with a DIFFERENT FuncVal
  generation than the module-field one), confirming the generation-churn
  defeat of the has_function guard.

## Gates (this commit)

corpus PASS 139 / DIFF 1 (pre-existing TS -O0 crash), `check ./std`
153/153, s1 battery green incl. async_await 116 / algebraic_effects 72 /
cycle_collector 16 / http 9 / regex 140 / json 35 / hash_map 61 / dyn 8,
6 new flips TS-count-identical, stage2 emit + clang, s2 battery,
STRICT_FIXPOINT — see commit message.
