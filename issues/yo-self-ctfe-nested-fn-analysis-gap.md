# yo-self: CTFE analysis was never applied to NESTED functions

**Status: the reported bug is FIXED (2026-08-05).** The file stays in `issues/`
rather than `issues/fixed/` because one of TS's three call sites is deliberately
still unwired — see "Remaining: the third site" at the end, which is a real finding
in its own right.

**Found** by answering the open question in `issues/yo-self-unwired-port-gaps.md`: is
`evaluator/ctfe/ctfe_analysis.yo`'s stub claim ("the analogous analysis is performed
inline in `comptime_fn.yo`") equivalent to TS, or a real gap? It was a real gap.

## Reproducer (now green on both compilers)

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  outer :: (fn(x : i32) -> i32)({
    helper :: (fn(y : i32) -> i32)({          // <-- the NESTED fn is one trigger
      return(y * 2);
    });
    return(helper(x));
  });
  c :: comptime_fn(outer);
  r :: c(20);
  println(`r = ${r}`);                        // <-- USED AT RUNTIME is the other
  ()
});
export(main);
```

| compiler    | before                                               | after           |
| ----------- | ---------------------------------------------------- | --------------- |
| TS (`src/`) | prints `r = 40`, folded to a literal `(int32_t){40}` | unchanged       |
| yo-self     | **C error:** `use of undeclared identifier 'r'`      | prints `r = 40` |

Regression coverage: `tests/comptime_fn_nested.test.yo` (5 tests). Verified to FAIL
on the pre-fix binary — **4 failed / 1 passed**, the single pass being the
deliberate no-nesting control — and 5/5 after.

## Root cause

TS calls `analyzeCtfeCapability` (`src/evaluator/ctfe/ctfe-analysis.ts`) from three
places; yo-self reached it from one:

| TS call site                                      | what it covers                                     | yo-self before | after      |
| ------------------------------------------------- | -------------------------------------------------- | -------------- | ---------- |
| `src/evaluator/builtins/comptime-fn.ts:73`        | the explicit `comptime_fn(f)` builtin              | PORTED         | PORTED     |
| `src/evaluator/calls/function-type.ts:669`        | a nested **named** `fn` definition met during CTFE | MISSING        | **WIRED**  |
| `src/evaluator/values/anonymous-function.ts:1127` | a nested **anonymous** fn met during CTFE          | MISSING        | still open |

Both missing sites are gated on
`context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings` — "we are
inside a CTFE analysis, **or actually executing a CTFE function**, so analyze this
nested function too and swap in the comptime version". The second half of that
disjunction is what this bug needed: `calls/comptime_fn.yo:912` sets
`force_compile_time_bindings = true` while executing a comptime call, so the nested
`fn` definition is re-evaluated on every comptime execution.

Without the swap, `helper` stayed runtime-only, `helper(x)` could not fold, the
comptime call produced no compile-time value, the `::` binding it fed got none — and
codegen emitted the bare Yo name as a C identifier that nothing declares.

## The fix

1. **`evaluator/ctfe/ctfe_analysis.yo`** — the stub became the real module, mirroring
   TS: `create_comptime_function_type` + `analyze_ctfe_capability`, plus the body
   proof, the `${funcId}_comptime` clone, `mark_fn_unemittable`, and the ten
   side-table copies. Extraction is what makes the fix possible: the analysis used to
   be private to `builtins/comptime_fn.yo`, which `calls/function_type.yo` cannot
   import without a cycle — the same reason TS keeps it in its own module. (Yo does
   tolerate the cycle through `exprs/begin.yo`; verified with `check yo-self/main.yo`.)
2. **`builtins/comptime_fn.yo`** — delegates (488 → 221 lines). Its four SPECIFIC
   precondition errors are kept as pre-flight checks: TS has no equivalents and just
   returns undefined, but "cannot convert a generic function" beats "not possible".
3. **`calls/function_type.yo`** — the new call site in
   `try_to_implement_function_by_function_type`, guarded by the same disjunction.

### Two things that are load-bearing, not hygiene

**Swallowing.** `analyze_ctfe_capability` wraps the body proof in a swallowing
handler, spelling TS's `try { … } catch { return undefined }`. This is essential at
the nested site: an ordinary runtime helper defined inside a comptime-executing body
is EXPECTED to fail the analysis and must be left untouched, not fail the compile.
yo-self spells it as the capture-free `->` handler + out-list idiom already used by
`_trial_eval_fn_body` (`calls/function_type.yo`) — `unwind` discards the
continuation, so a swallowed analysis leaves the out-list empty.

**Restoring the CTFE context flags OUTSIDE the unwind target.** `_eval_body_for_ctfe`
restores `is_analyzing_ctfe_capability` / `force_compile_time_bindings` /
`is_executing` / the fn-body ctx after the body evaluation. Those lines never run on
the failure path: `unwind` discards the continuation, so a swallowed analysis exits
past them and leaves the context in CTFE mode **for the rest of the compile**. The
save/restore therefore also happens in `analyze_ctfe_capability`, around the call to
`_try_eval_body_swallowing` — `unwind` only unwinds as far as that helper, so code
after the call always runs.

This was the actual regression this change first shipped: `tests/fn.test.yo` went
HOLLOW — its `main` failed to transpile, so it reported "24 passed" while running
nothing — even though all 24 tests passed individually and every single-file repro was
clean. Only the cumulative slice reproduced it (tests 1-12 clean, 1-13 broken), and
test 13 alone was clean, because the leak needs one FAILED analysis followed by
anything else being compiled. Caught by `gates_fast.sh`'s hollow detection, which is
the only gate that can see it: fixpoint, corpus 155 and `check ./std` were all green
on the broken build. The general lesson is recorded in
`.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`: **adding a swallow
handler to existing code is not behaviour-preserving** — code whose errors used to
propagate (aborting the compile, so leaked state never mattered) starts leaking the
moment you swallow.

**Analysing a fresh-id CLONE of the body.** TS does `cloneExpr(functionValue.body)`;
the old inline yo-self version analysed the ORIGINAL tree, which was harmless only
because nothing else consumed the result. With the nested site wired, analysing the
original **clobbered the nested `fn`'s ExprInfo with the comptime clone** — which is
marked UNEMITTABLE — so the enclosing RUNTIME function emitted
`// Failed to transpile helper(x)`. That was the second failure mode seen while
developing this fix, and it is why `tests/comptime_fn_nested.test.yo`'s last test
asserts the same nested function still works at runtime. yo-self's ExprInfo table is
keyed by expr id, so any CTFE-mode evaluation of a shared tree overwrites the runtime
annotation — the same hazard documented at `calls/comptime_fn.yo:913-919`.

## Why every existing gate missed it

`tests/fn.test.yo:544` already contains the nested shape — `factorial` with a nested
`factorial_acc`, then `comptime_fn(factorial)` — and passed on both compilers,
because it only ever checks the result with `comptime_assert`:

| shape                                         | agreed before the fix? |
| --------------------------------------------- | ---------------------- |
| no nesting + result used at runtime           | yes (40)               |
| nesting + result used only in comptime_assert | yes (both "pass")      |
| **nesting + result used at runtime**          | **NO — diverged**      |

That combination existed nowhere in `./tests`, `tests/internal`, the 155-file corpus,
`./std`, or the fixpoint.

## Separate finding: that `comptime_assert` is VACUOUS — in BOTH compilers

```rust
c :: comptime_fn(outer);   // outer has a nested fn
r :: c(20);                // = 41
comptime_assert(r == 999); // accepted by TS *and* yo-self
```

**Not** a port gap — the TS compiler accepts it too — but it means the nested-CTFE
assertions in `tests/fn.test.yo` assert nothing. Worth fixing on the TS side
separately: a `comptime_assert` that cannot prove its argument should not silently
succeed. Recorded so it is not mistaken for the divergence above, and because it is
the general reason a comptime test must ALSO use its value at runtime.

## Remaining: the third site, and why it was NOT wired

`values/anonymous_function.yo` is still unwired, deliberately. TS gates its site on
`!isCreatingClosure`, and **the two compilers derive that flag from different
things**:

- TS (`anonymous-function.ts:201-222`): `isCreatingClosure = true` when the EXPECTED
  TYPE is a `SomeType` wrapping an Fn trait (`Impl(Fn(...))`); false for a plain
  `fn(...)` expected type.
- yo-self (`anonymous_function.yo:663`): `is_creating_closure := !(op_is_arrow)` —
  purely SYNTACTIC, false only for the `->` form.

So the gate is not equivalent, and wiring the site against yo-self's flag would fire
on a different set of expressions than TS's. That discrepancy needs resolving first;
it is a pre-existing divergence in the anonymous-function port, not something this
change introduced. Until then the site is knowingly absent, which affects anonymous
functions nested inside a CTFE body — a shape with no coverage anywhere today.
