# A dyn method's async Future-trait return type emitted its struct TWICE — "redefinition of '__yo_t60_struct'"

**Status: OPEN (fix in flight on the branch that reverts #370).** Found
2026-08-31 diagnosing why the `tests/dyn.test.yo` batch went RED under the
self-hosted compiler the moment #370's prelude shrink landed (the develop-HEAD
hollow sweep reported `tests/dyn.test.yo RED`, and every native suite leg died
on the same C error). The trigger is #370, but the defect is older: an
on-demand declaration path and the main type-declaration passes never shared
an "already emitted" set.

## Symptom

`yo test ./tests/dyn.test.yo` fails in the BATCH C compile:

```text
tests/.yo_selftest_batch_1_0.bin.c:872:8: error: redefinition of '__yo_t60_struct'
  872 | struct __yo_t60_struct { // Generic Future interface for Future[Future](usize) IoExn : IoExn
tests/.yo_selftest_batch_1_0.bin.c:857:8: note: previous definition is here
```

Line 856/857 is the ON-DEMAND emission (its forward typedef is commented
`// Forward declaration (on-demand)`), followed by the `dyn(AsyncRead)`
vtable whose `read` method returns `__yo_t60*`, followed at 872 by the SAME
struct body again — emitted by `generate_type_declarations`' fifth pass.

## Mechanism

`generate_type_declarations` (src/codegen/types/generation.yo) emits type
bodies in several passes over `context.types`. A dyn type's async method
return type (`Impl(Future(...))` → a `FutureTraitT`) is collected LAZILY —
the Future-trait interface struct is minted when the dyn vtable resolves the
method signature, i.e. DURING the fifth pass (or the dyn forward-declaration
step). Resolving that type's C name fires the on-demand declare hook
(`_on_demand_collect_and_declare` in src/codegen/codegen_c.yo), which emits
the forward typedef AND the full body immediately. The fifth pass's own
iteration then reaches that same entry later and emits the body a second
time — one C name, two definitions, clang error.

The pass-local dedup (`emitted_decl_cnames`, a HashSet local to
`generate_type_declarations`) only deduplicated WITHIN the function; the
on-demand hook knew nothing about it. #370's prelude shrink (two fewer
top-level prelude exprs, every `yo_id` shifting) merely changed collection
order enough to make a Future-trait arrive lazily at pass time — the
double-emission path itself predates it.

## Fix

`CodeGenContext.type_body_declared : HashSet(String)` — C names of type
bodies already emitted, shared by every body-emission site:

* the on-demand hook (codegen_c.yo) checks-and-marks before emitting;
* `generate_type_declarations`' simple-enum, topological struct/enum/tuple,
  nullable-pointer-enum, and dyn/union/future-trait passes all check-and-mark.

Keyed on the C NAME (like `type_id_static_names`): evolved type_keys alias
onto one C name via `register_type_alias`, so key-based dedup would still
double-emit. Marking happens BEFORE the emit call so a generator that
re-enters the hook for its own nested types cannot re-emit itself.

Fixpoint-safe by construction: it only suppresses emissions that would have
been C errors; a tree whose C compiled before emits byte-identical C after.

## Reproducer

`yo test ./tests/dyn.test.yo --parallel 1` with a compiler built from a tree
containing #370 (before the fix) — batch compile fails with the redefinition
error above; after the fix, 9/9 pass.
