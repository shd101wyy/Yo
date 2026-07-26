# TS while-loop body scope-end drops lack begin.ts's two guards → invalid C / double drop

**Status:** OPEN — found 2026-07-26 while porting yo-self validations (the
atomic-Send helper's first draft triggered it); reproduced standalone.
**Where:** `src/codegen/exprs/while.ts:112-119` (`generateLoopBody`, the
begin-block branch's end-of-body drop pass).

## Reproducer (25 lines, `src/tests/fixme.yo` shape)

```rust
open(import("std/fmt"));
{ ArrayList } :: import("std/collections/array_list");
make_list :: (fn(n : usize) -> ArrayList(usize))({
  out := ArrayList(usize).new();
  (k : usize) = usize(0);
  while(k < n, {
    out.push(k);
    k = (k + usize(1));
  });
  out
});
main :: (fn() -> unit)({
  (i : usize) = usize(0);
  (hits : usize) = usize(0);
  while(i < usize(3), {
    flagged := ((i == usize(0)) || (make_list(i).len() > usize(1)));
    if(flagged, { hits = (hits + usize(1)); });
    i = (i + usize(1));
  });
  println(`${hits}`);
});
export(main);
```

`./yo-cli compile src/tests/fixme.yo --release` →
`error: use of undeclared identifier '_yo..._temp_...'` (clang), rc=1.

## Mechanism

The `||` RHS has side effects, so `generateOpOr` (and-or.ts) emits an if-chain;
the owned temp (`make_list(i)`'s ArrayList) is declared INSIDE the conditional
block and correctly dropped there by `emitDropsForConditionalBranch`, which
also records the name in `functionContext.shortCircuitHandledDropVarNames`.

`begin.ts`'s scope-end drop pass honors two guards:

1. `declaredCVarNames` — skip a codegen TEMP whose C declaration was never
   emitted in this scope (begin.ts:177-186);
2. `shortCircuitHandledDropVarNames` — skip drops already emitted inside a
   short-circuit conditional branch (begin.ts:188-200).

`while.ts`'s `generateLoopBody` has its OWN end-of-body drop pass for loop
bodies (it inlines the begin block instead of delegating) and applies NEITHER
guard, so the temp's drop is re-emitted at the loop scope end where the C
identifier does not exist → clang error. When the temp IS declared
unconditionally, the same gap yields a silent DOUBLE drop instead.

## Fix sketch

Apply the same two skip-guards in `generateLoopBody`'s drop loop
(while.ts:112-119) that begin.ts applies. **Emission-identity warning:** the
yo-self codegen mirrors this emitter (`yo-self/codegen/exprs/while.yo` /
begin.yo's `declared_c_var_names` gate) — the fix must land in BOTH compilers
in the same batch or the corpus diff-test / STRICT_FIXPOINT will flag the
divergence.

Related: `issues/yo-codegen-block-rhs-drops-statements.md` family;
`_is_dots_atom`'s comment in `yo-self/evaluator/types/function.yo` records the
same `&&`-short-circuit hazard from the consumer side.
