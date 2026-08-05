# yo-self: CTFE analysis is never applied to NESTED functions (CONFIRMED, OPEN)

**Found:** 2026-08-05, by answering the open question in
`issues/yo-self-unwired-port-gaps.md`: is `evaluator/ctfe/ctfe_analysis.yo`'s stub
claim ("the analogous analysis is performed inline in `comptime_fn.yo`") actually
equivalent to TS, or is it a real gap?

**Answer: it is a REAL GAP.** The analysis exists, but TS invokes it at **three**
sites and yo-self at **one**. The two missing sites are exactly the ones that handle
a nested function met while a CTFE analysis is already in flight.

## Minimal reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  outer :: (fn(x : i32) -> i32)({
    helper :: (fn(y : i32) -> i32)({          // <-- the NESTED fn is the trigger
      return((y * 2));
    });
    return(helper(x));
  });
  c :: comptime_fn(outer);
  r :: c(20);
  println(`r = ${r}`);                        // <-- USED AT RUNTIME is the trigger
  ()
});
export(main);
```

| compiler    | result                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| TS (`src/`) | compiles, prints `r = 40`; the binding is folded to a literal `(int32_t){40}` |
| yo-self     | **C compile error:** `use of undeclared identifier 'r'`                       |

The emitted self-hosted C references the Yo-level name directly and nothing declares
it:

```c
void __yo_user_main() {
  ...
  __yo_t4 _file____tmp__temp_5169 = yo_id_4787((&(r)));   // 'r' never declared
```

## Root cause

TS calls `analyzeCtfeCapability` (`src/evaluator/ctfe/ctfe-analysis.ts`) from three
places:

| TS call site                                      | what it covers                                     | yo-self |
| ------------------------------------------------- | -------------------------------------------------- | ------- |
| `src/evaluator/builtins/comptime-fn.ts:73`        | the explicit `comptime_fn(f)` builtin              | PORTED  |
| `src/evaluator/calls/function-type.ts:669`        | a nested **named** `fn` definition met during CTFE | MISSING |
| `src/evaluator/values/anonymous-function.ts:1127` | a nested **anonymous** fn met during CTFE          | MISSING |

Both missing sites are gated on
`context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings`, i.e. "we are
inside a CTFE analysis, so analyze this nested function too, and if it succeeds swap
in the comptime version". Without that swap, `helper` stays a runtime function, the
`helper(x)` call inside the CTFE-mode body cannot fold, so the analysis of `outer`
fails, `r` gets no compile-time value — and codegen then emits the bare Yo name.

yo-self's counterparts of the two sites are
`yo-self/evaluator/calls/function_type.yo` (`try_to_implement_function_by_function_type`,
line 577 — the port of TS's `tryToImplementFunctionByFunctionType`) and
`yo-self/evaluator/values/anonymous_function.yo`. Both flags DO exist on
`EvalContext` (`yo-self/evaluator/context.yo:285,287`) and are used elsewhere, so
only the analysis calls are absent.

## Why every existing gate missed it

`tests/fn.test.yo:544` already contains this exact shape — a `factorial` with a
nested `factorial_acc`, then `comptime_fn(factorial)` — and it passes on both
compilers. It passes because it only ever uses the result inside
`comptime_assert`, never at runtime. That distinction is the whole bug:

| shape                                         | both compilers |
| --------------------------------------------- | -------------- |
| no nesting + result used at runtime           | agree (40)     |
| nesting + result used only in comptime_assert | agree (pass)   |
| **nesting + result used at runtime**          | **DIVERGE**    |

So the differential sweep (`./tests` 187/187, `tests/internal` 58/58), the 155-file
corpus, `check ./std` and the fixpoint are all blind to it: the failing combination
appears nowhere in the tree.

## Separate finding: that `comptime_assert` is VACUOUS — in BOTH compilers

While isolating the above, changing `tests/fn.test.yo`'s style of assertion to a
deliberate lie still compiles:

```rust
c :: comptime_fn(outer);   // outer has a nested fn
r :: c(20);                // = 41
comptime_assert(r == 999); // accepted by TS *and* yo-self
```

This is **not** a port gap — the TS compiler accepts it too — but it means the
nested-CTFE assertions in `tests/fn.test.yo` are not actually checking anything.
Worth fixing on the TS side separately (a `comptime_assert` that cannot prove its
argument should not silently succeed); tracked here only so the next reader does not
mistake it for the divergence above.

## Fixing it

The stub file `yo-self/evaluator/ctfe/ctfe_analysis.yo` is the right home, and
extracting it is what makes the fix possible at all: yo-self's analysis currently
lives inside `evaluator/builtins/comptime_fn.yo` as a private
`_analyze_ctfe_capability` (line 88, ~128 lines), and `calls/function_type.yo`
cannot import that without a cycle. TS avoids the same cycle by having
`ctfe-analysis.ts` be its own module — so the 1-to-1 port and the fix are the same
piece of work.

Note the existing yo-self helper is **not** a drop-in: it takes decomposed pieces
(`param_labels`, `param_types`, `body_box`, `cap_names/tys/vals`, `func_type`) and
returns `Option(TypeValue)`, shaped for `comptime_fn`'s needs, whereas the two new
callers need "given a function value, hand me back the comptime function value".
Extracting it means generalising that signature toward TS's.

Risk note: `calls/function_type.yo` is the def-time body-eval path and is one of the
most fixpoint-sensitive files in the compiler. Re-run the full gate chain
(`gates_fast.sh` then `fixpoint_only.sh`) after touching it, not just the repro.

Add the reproducer above to `./tests` as part of the fix — deliberately NOT added
before it, because it is a self-hosted-only failure and would turn the honest
differential baseline red while telling the next reader nothing this file does not.
