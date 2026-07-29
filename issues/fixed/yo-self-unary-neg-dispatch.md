# yo-self: unary `-` on a TYPED value is broken in BOTH the CTFE and runtime paths

**Status:** FIXED by `0226c4865` (associated-type substitution at trait-impl
registration) — BOTH layers cleared: the CTFE repro compiles rc=0 and the
runtime repro compiles AND runs. Regression test: tests/operator_grouping.test.yo
"unary negation of typed values". Original analysis below. Was pre-existing
(reproduced on the 2026-07-29 tree before the contracts port). Only `-(comptime_int literal)` works, via the
`ComptimeNegate` impl on `comptime_int` (`__yo_comptime_int_neg`) — which is
why the gap survived: tests overwhelmingly negate literals.

This is the root under BOTH:

- `tests/spec/contracts_phase0.test.yo` — its ONE remaining hollow arm (t21:
  `abs :: (fn(comptime(x) : i32, requires(...)) -> comptime(i32))(cond(... => x, true => -(x)))`).
  The contract wrap is exonerated: the same body **without any contract
  clauses** fails identically.
- `tests/comptime.test.yo` HOLLOW — the root-cause map's
  `Return type mismatch. Expected type "f32", but got "Output".` is the same
  error shape with an f32 receiver.

## Layer 1 — CTFE: associated type `Output` unresolved

```rust
f :: (fn(comptime(x) : i32) -> comptime(i32))(-(x));
G :: f(i32(-(50)));
```

s1 error (module-level binding surfaces it; inside a fn body it is def-time
swallowed and FTTs the statement):

```
check: error in: Error: Return type mismatch. Expected type "i32", but got "Output".
./std/prelude.yo:592:5:
    return(self.neg());
```

i.e. inside the prelude's generic runtime `(neg)`
(`fn(generic(_Self), self : _Self, where(_Self <: Negate)) -> _Self`,
prelude:584-592), the trait-method call `self.neg()` keeps its declared
`Self.Output` return type unresolved for the numeric receiver. Note TWO
things must be wrong here: (a) TS dispatches a comptime `i32` to the
`comptime_neg` overload, not the runtime one; (b) even on the runtime
overload, `Output` must resolve to i32 via the `impl(i32, Negate(Output : i32, …))`
registration. Compare the earlier fix for enum receivers
(`_try_resolve_associated_type` in property_access.yo,
[[yo-self-assoc-type-enum-receiver]]) — numeric receivers likely miss the
same registry lookup.

## Layer 2 — runtime: codegen FTTs the dispatch

```rust
f :: (fn(y : i32) -> i32)(-(y));
z := f(i32(50));
```

TS emits the two-hop dispatch
(`f → fn_…_neg (specialized generic) → fn_…_neg_i32 (impl) → __yo_op_neg`).
s1 emits:

```c
static inline int32_t yo_id_4672(int32_t y) {
  return // Failed to transpile -(y);
}
```

rc=1, `error: expected expression`. The EVALUATOR accepted the body (def-eval
clean; the standalone fn with no caller compiles rc=0 because the dead fn is
never emitted) — the failure is the CODEGEN of the unary operator call.

## Probe matrix (all under `/tmp/ctrx_s1`, 2026-07-29)

| probe                                                | result             |
| ---------------------------------------------------- | ------------------ |
| `{ comptime_assert(...); x }` comptime body          | PASS               |
| `{ y :: x; cond(... => y, true => y) }` (no neg)     | PASS               |
| `{ y :: x; cond(... => y, true => -(y)) }` arm TAKEN | FAIL               |
| same, negation arm NOT taken                         | PASS               |
| `-(x)` direct comptime body                          | FAIL (Output)      |
| runtime `z := -(y)` in main                          | FAIL (codegen FTT) |
| `Z :: -(Y)` where `Y :: i32(50)`                     | FAIL               |
| `-(50)` literal (comptime_int)                       | PASS               |

Repro files: `/tmp/cp1_mod.yo` (layer 1), `/tmp/negrt3.yo` (layer 2).

## Where to start

- TS overload selection for `-(x)`: prelude `(-)` impl `Call :: (neg, comptime_neg)`;
  find how TS picks `comptime_neg` for a comptime-valued i32 (where-clause
  `_Self <: (Comptime, ComptimeNegate)`) and whether s1's trial rejects it.
- The `Self.Output` resolution for numeric receivers at trait-method CALL
  return typing (registry: `get_type_trait_methods_by_name(type_id, "Output")`;
  does `type_id_or_empty` even produce an id for numeric primitives? cf. the
  Pointer-case gap in [[yo-self-forward-ref-impl-pointer-collection]]).
- Codegen layer 2: what the emitted-call path needs that the evaluator didn't
  annotate (specialized_function_value / runtime_arg_exprs on the `-(y)` call).
