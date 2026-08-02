## 1. MINIMAL REPRO

`/Users/yiyiwang/Workspace/Yo/scratchpad/t1/repro6.yo` (copy of `scratchpad/w1/repro6.yo`, unchanged) — a hand-written `CountIter` + `iter.filter(x => x.* > 2)`.

```
./yo-cli compile scratchpad/t1/repro6.yo --release -o /tmp/t1_r6_ts   # rc=0, binary runs rc=0
/tmp/sh172   compile scratchpad/t1/repro6.yo --release -o /tmp/t1_r6   # rc=1
```

`/tmp/sh172` error (verbatim, first line):

```
/tmp/t1_r6.c:1376:11: error: initializing '__yo_t3' (aka 'struct __yo_t3_struct') with an expression
of incompatible type '__yo_t2' (aka 'struct __yo_t2_struct')
```

Measured struct comments in `/tmp/t1_r6.c`: **two** `IterFilter` C structs with identical layout —
`<struct:struct_yo_id_2935>` (`__yo_t3`) and `<struct:struct_yo_id_4986>` (`__yo_t2`).
TS `/tmp/t1_r6_ts.c`: **one** — `__yo_struct_yo1c2129e9_id_47682 // IterFilter(CountIter, __impl_fn(Fn(item : *(i32)) -> bool))`.

Both target files are confirmed HOLLOW on HEAD (marker-checked, not assumed):

- `tests/iter_filter_closure.test.yo` — "3 passed", `hollow=1`
- `tests/iterator_combinators.test.yo` — "19 passed", `hollow=1`

## 2. THE RECORDED ROOT IS WRONG (negative result, measured)

The recorded root — anonymous `Fn`/`Eq` traits re-minted with fresh ids, giving
`F : (Fn(A) -> bool + Fn(i32) -> bool + Fn(i32) -> bool)` — **is already fixed at HEAD** by commit
`4c9113f0a`. Measured spec key on `/tmp/sh172`:

```
F____Fn___A______bool__id_1250_rtparam0_...        # ONE bound, not three
```

(`grep -o "F____Fn[A-Za-z0-9_]*" /tmp/t1_r6.c`). repro6 still fails **identically**, so trait-bound
accumulation was never this family's cause. `scratchpad/w1/repro7.yo` (closure `.map`) is a
_different_ root: its 3rd `IterMap` CTFE call gets `F = fn(item : i32) -> i32` (a bare `Func`) and the
whole `it1.map(...)` statement fails to transpile — no two-struct split at all.

## 3. ROOT (measured with a probe binary)

Probe tree: `/Users/yiyiwang/Workspace/Yo/scratchpad/t1/ys` (copy of `yo-self/`), probe binaries
`/tmp/t1probe` (faithful + prints), `/tmp/t1probe3`, `/tmp/t1probe5`.
Log: `/Users/yiyiwang/Workspace/Yo/scratchpad/t1/r6_probe2.log`.

Four `IterFilter` CTFE calls, printed at the memo decision point:

| #   | args (`stable_type_identity`)               | should_cache | hit   | result              |
| --- | ------------------------------------------- | ------------ | ----- | ------------------- |
| 1   | `I : (Iterator)` , `F`                      | false        | false | `struct_yo_id_2864` |
| 2   | `I : (Iterator)` , `F : (Fn(*(A)) -> bool)` | false        | false | `struct_yo_id_2935` |
| 3   | `CountIter` , **`F : (Fn(*(A)) -> bool)`**  | true         | false | `struct_yo_id_4984` |
| 4   | `CountIter` , **`capture_yo_id_4982`**      | true         | false | `struct_yo_id_4986` |

**yo-self passes two different `F`s to the same type constructor.** Calls 3 and 4 are the
signature-side and body-side `IterFilter(Self, F)`; because `F` is the where-clause SomeT at one and
the bare capture struct at the other, the memo legitimately misses and mints two identities.
TS passes ONE thing at both (`__impl_fn`, `sometype_yo3519fd7f_id_53`) → one memo entry → one struct.

**And a third identity wins at the signature.** Probe on `expr_info_table_set`:

```
__DBG_SET expr=57845 sid=struct_yo_id_2935 tyargs=CountIter|F : (Fn(*(A)) -> bool)|
```

i.e. the specialized return type is `substitute(def-era 2935, {I→CountIter})` — `substitute` **preserves
the struct id** (`yo-self/types/substitution.yo:301`, `.Struct(id, name, labels, new_types, …)`), and
`F` is left unsubstituted in `type_arguments`. That instance never passes through the CTFE memo.

Precise gate that keeps it (measured `__DBG_RTE_GATE spec_ret=struct_yo_id_2935 g1=false g2=false g3=false`):

- **`/Users/yiyiwang/Workspace/Yo/yo-self/evaluator/calls/helper.yo:2129`** — the return-type-EXPRESSION
  re-evaluation only runs when the substituted type still shows SomeTs. After substitution the
  **fields** are concrete (`_inner: CountIter`, `_f: capture`); the SomeT survives only in
  `type_arguments`, which `get_all_some_types` does not walk. Gate = false → never re-evaluated.
- **`/Users/yiyiwang/Workspace/Yo/yo-self/evaluator/calls/helper.yo:2165`** — even when it does run, the
  result is rejected unless it is SomeT-free.
- **`/Users/yiyiwang/Workspace/Yo/yo-self/evaluator/types/function.yo:4773`** —
  `evaluate_function_return_type_again` resolves/substitutes an existing TypeValue; it never
  re-evaluates the expression.

## 4. TS MECHANISM

`src/evaluator/types/function.ts:2836-2844` — TS re-evaluates the return **expression**, unconditionally:

```ts
  const evaluatedFunctionReturnExpr = evaluateExpression({
    expr: cloneExpr(functionReturn.typeExpr),
    env: calleeEnv,
```

called unconditionally from `src/evaluator/calls/helper.ts:2364-2373`:

```ts
  // Resolve the return type by re-evaluating it in the specialized environment
  const { returnType: specializedReturnType, ... } = evaluateFunctionReturnTypeAgain({
```

There is no "still contains SomeType" gate and no acceptance filter (`function.ts:2846-2860` takes
the result as-is). That call re-enters `IterFilter(...)` through the memo
(`src/evaluator/calls/comptime-fn.ts:96-171`), so signature and body share one instance.

`src/evaluator/values/anonymous-function.ts:1203-1216` — why TS's `F` is stable and a SomeType:

```ts
    const wrapperHasFnInRequired = wrapperType.requiredTraits.some(
      ({ traitType }) => traitType.id === expectedFnTraitType.id
    );
    if (!wrapperHasFnInRequired && captureType) {
      const implFnWrapper = createSomeType(createType0(), "__impl_fn", {
        requiredTraits: [expectedFnTraitType], env, context,
      });
      implFnWrapper.resolvedConcreteType = captureType;
      wrapperType.resolvedConcreteType = implFnWrapper;
```

`src/evaluator/calls/helper.ts:2242-2252` — TS unwraps `resolvedConcreteType` **only for
`runtimeParameters`** (the C parameter type), never for the compile-time forall binding.

## 5. YO-SELF DELTA (each anchor verified `grep -Fc == 1`)

| #   | file:line                                             | text                                                                                                                         |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A   | `yo-self/evaluator/calls/helper.yo:2129`              | `if(((get_all_some_types(spec_ret_ty).len() > usize(0)) \|\| _type_has_array_len_var(spec_ret_ty)) \|\| rte_has_ct_param, {` |
| B   | `yo-self/evaluator/calls/helper.yo:2165`              | `if(((get_all_some_types(rte_ty).len() == usize(0)) && !(_type_has_array_len_var(rte_ty))) && !(is_unit_type(rte_ty)), {`    |
| C   | `yo-self/evaluator/values/anonymous_function.yo:1763` | `// where-clause-constrained generics (ts:1205-1216) is NOT ported — those`                                                  |
| D   | `yo-self/evaluator/calls/function.yo:2092`            | `(arg_ty_spec : TypeValue) = match(ainfo.capture_type,.Some(ct) => ct,.None => ainfo.ty);`                                   |

## 6. PROPOSED PATCH — I HAVE NONE THAT WORKS. Two candidates measured and REJECTED.

Both applied to the copy at `scratchpad/t1/ys`, `./yo-cli fmt` + `./yo-cli check` clean (0 `error in`
lines), full yo-self build rc=0.

**Candidate 1** (`/tmp/t1probe3`) — teach `_ctfe_args_equal` to resolve a SomeT arg through its
`resolved_concrete` before declaring a mismatch. Memo now hits (`hit=true`, body reuses `4984`).
**Repro still fails**, roles merely swap: `initializing '__yo_t2' (4984) with '__yo_t3' (2935)`.
Also not TS-faithful — `comptime-fn.ts:127-135` explicitly returns `false` when one side is a
SomeType and the other is not.

**Candidate 2** (`/tmp/t1probe5`) — candidate 1 **plus** force the helper.yo:2129 gate always-on and
accept the re-evaluated type unconditionally (TS's shape). The re-eval now fires
(`__DBG_RTE_OUT rte_ty=struct_yo_id_4964 nsomes=0`) but runs _after_ the body with the other `F`,
so the split just moves: caller+body agree on `4962`, the emitted signature declares `4964`.
**Repro still fails.**

Conclusion: the return-type re-evaluation (delta A/B) is necessary but not sufficient. The load-bearing
fix is delta **C/D** — make `F` read as ONE stable SomeType at the return-type site and the body site,
i.e. port `__impl_fn` so `F.resolved_concrete` is a SomeType wrapping the Fn trait rather than the bare
capture struct, and stop letting `arg_ty_spec` (the capture struct, correct for the _runtime parameter_)
become the _comptime forall_ binding. Then all three `IterFilter(...)` calls land on one memo entry and
A/B become a consistency requirement rather than a second source of divergence.

## 7. BLAST RADIUS

- **A/B (helper.yo:2129/2165)** is on the main specialization path for every generic/impl-generic call.
  Turning the gate fully on cost nothing measurable on the yo-self self-build (2:11 vs 2:15), but it
  changes the return type of every specialization whose declared return is a comptime constructor call.
  Realistic regressions: `Self`-returning methods where `adopt_receiver_struct_instance`
  (`expr_info.yo:840`) currently supplies the right instance; array-length-var returns; the
  `where_clause_fn_inference` fix that just landed (it stamps through
  `evaluate_function_return_type_again`).
- **C/D (`__impl_fn`)** touches every closure argument: `Thread.spawn`, the parallelism runtime, the
  io.async pipeline. The existing comment at `anonymous_function.yo:1755-1776` records that a related
  widening broke all 12 `io_async` corpus files, and `helper.yo:2375` records the
  `arc-spawn-capture-split` hazard from sharing one SomeT lineage across specializations. Any port must
  keep the per-spec rebuild there.
- Canary set for either: `tests/iter_filter_closure`, `tests/iterator_combinators`, the io_async corpus,
  `issues/repros/arc-spawn-capture-split.yo`, `closure_capture_rc_leak`.

## 8. CONFIDENCE

- Recorded root refuted: **high** (measured, one bound in the key, identical failure).
- Root = two different `F` values + a substitution-preserved def-era struct id: **high** (four-row CTFE
  table, `__DBG_SET`, `__DBG_RTE_GATE`, TS side shows one struct with `__impl_fn`).
- That porting `__impl_fn` fixes it: **medium**. Not measured.

**Cheapest observation that settles it:** in the probe tree, make the specialized body's comptime `F`
binding be the same SomeT the return-type path uses (do _not_ substitute `arg_ty_spec` into the forall
at `function.yo:2092`; leave the capture struct for the runtime parameter only), rebuild (~2.5 min) and
re-run `/tmp/t1probe compile scratchpad/t1/repro6.yo`. Success signature is exact: rows 3 and 4 of the
`__DBG_CTFE name=IterFilter` table collapse to one `hit=true`, and
`grep -o "<struct:struct_yo_id_[0-9]*>" /tmp/t1_r6.c | sort -u` prints a single id.
