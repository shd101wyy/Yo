# fn.test.yo: 5 hollow arms, not 1. blk10 alone does NOT flip it.

## 0. HEADLINE

`tests/fn.test.yo` has **five** hollow arms on HEAD (`/tmp/sh172`). blk10 = arm 9. Fixing it leaves four more.
With all five fixes below applied and built (`/tmp/t3all`), fn goes **9,12,13 → hollow=0**, **11 → still hollow (2nd layer)**, **14 → hollow=0 but rc=1 (codegen layer)**. So fn is **not** reachable this round; two more roots stand behind it.

Method: `scratchpad/t3/hollow.sh <bin> <file>` = `rm -f <dir>/.yo_selftest_batch_*; YO_KEEP_BATCH=1 <bin> test <f> --parallel 1` then marker count in `__yo_user_main`. Roots harvested with an un-silenced-swallow probe (`/tmp/t3dbg` = HEAD + `eprintln` in `_trial_eval_fn_body`'s `inner_exn`). Baseline noise = **34** `__DBG_F` lines; every hollow arm had exactly **35** — the 35th is the root.

## 1. THE FIVE ARMS (measured, /tmp/sh172, hollow=1 each; other 19 arms hollow=0)

| arm | name (line)                                       | 35th swallowed error                                                                           | minimal repro                  |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| 9   | Test generic functions (342)                      | `Cannot unify: Expected "Tuple(0:T,1:Y)" Given "Tuple(0:i32,1:bool)"`                          | recorded blk10                 |
| 11  | Test 'recur' (529)                                | `recur: missing function type in context`                                                      | `scratchpad/t3/r/r11d.test.yo` |
| 12  | Test comptime function (562)                      | `Expected compile error, but the expression was evaluated successfully: result2 :: runt_id(n)` | `r/v3.test.yo`, `r/v4.test.yo` |
| 13  | Test function overloading using module Call (609) | `... add(4, 5, 6, 7)`                                                                          | `r/r13a.test.yo`               |
| 14  | Test mutual recursion (625)                       | `Incompatible types: Expected fn(n:i32)->bool  Given <struct:struct_yo_id_5940>`               | `r/r14a.test.yo`               |

All five repros: TS `./yo-cli test <repro>` = **1 passed** for every one.

## 2. ROOTS + TS MECHANISM + PATCH (each anchor `grep -c` == 1, verified)

### A — arm 11 layer 1: `comptime_fn` hides the function type from `recur`

ROOT `yo-self/evaluator/builtins/comptime_fn.yo:164` — `func_type : Option(TypeValue).None,` with a comment claiming "begin.yo … does not read func_type". `evaluate_recur` **does** read it and hard-errors at `yo-self/evaluator/exprs/recur.yo:128`.
TS `src/evaluator/ctfe/ctfe-analysis.ts:183-188`:

```ts
isEvaluatingFunctionBodyOrAsyncBlock: {
  kind: "function-body",
  type: comptimeFunctionType,
  value: comptimeFunctionValue, // Use the compile-time function value for recur
```

PATCH: `func_type : Option(TypeValue).Some(func_type),` (drop the stale NOTE comment). **Measured: r11d hollow 1 → 0.**

### B — arm 12: the `::`-binds-a-runtime-value rejection can never fire for a call

ROOT `yo-self/evaluator/exprs/initialization_assignment.yo:466` — `if(rhs_value_opt.is_none() && effective_is_compile_time_only, ...)`. yo-self stores a **runtime-only `UnknownVal` placeholder** for every runtime call (`_call_result_unknown`, `evaluator/calls/function.yo:144`), so `.is_none()` is false. Measured: `r :: n` (runtime var, value `.None`) **is** rejected; `r :: runt_id(5)` and even `r :: five()` are **not** (`r/v5.test.yo` hollow=0).
TS `src/evaluator/calls/helper.ts:1752-1754` — `let returnValue: Value | undefined;` assigned _only_ inside `if (functionType.return.isCompileTimeOnly)`; and `src/evaluator/exprs/initialization-assignment.ts:325`: `if (!rhsValue && effectiveIsCompileTimeOnly)`.
yo-self's own `value.yo:895-905` doc says the runtime-only flag "is yo-self's marker for _TS would have had no value here_" — so this is the sanctioned reading.
PATCH:

```rust
rhs_has_no_ct_value := match(
  rhs_value_opt,
  .Some(_rv) => is_runtime_only_unknown_val(_rv),
  .None => true
);
if(rhs_has_no_ct_value && effective_is_compile_time_only, {
```

plus `is_runtime_only_unknown_val` added to the `value.yo` import at line 49. **Measured: arm 12 hollow 1 → 0.** _(This is the one patch with a regression — see §4.)_

### C — arm 13: a `Call`-module call with no matching overload silently succeeds

ROOT `yo-self/evaluator/calls/function.yo:868` — `if(successes.len() == usize(0), { return(()); });`. `_try_expand_call_overload` is a _pre-pass_ that overwrites the callee ExprInfo with the winner; on zero matches it no-ops and the source-namespace struct callee falls through to the struct path, which accepts `add(4,5,6,7)`.
TS has no such fallback: `src/evaluator/calls/function.ts:553-587` **replaces** the function list with exactly the `Call` tuple elements, and `function.ts:1827-1834` throws:

```ts
throw formatErrorMessages([{ token: func.token,
  errorMessage: `No matching call found with arguments:\n${exprToString(expr)}\n\n...` }, ...
```

(TS on the plain repro `scratchpad/t3/r/p13.yo`: `Error: No matching call found with arguments:` — yo-self `check`: `evaluator OK`.)
PATCH: add `exn : Exception` to `_try_expand_call_overload`'s signature (one call site, `function.yo:2732`), and throw `No matching call found with arguments:\n${ast_expr_to_string(call_expr)}` before the `return(())`. **Measured: arm 13 hollow 1 → 0.**

### D — arm 14 layer 1: `_(...)` with a concrete expected FUNCTION type builds a struct

ROOT `yo-self/evaluator/exprs/_expr.yo:550` — the reroute is gated on `expected_is_anon_struct` (UNNAMED struct only); the header comment at :531-539 documents the deliberate narrowing (`issues/fixed/yo-self-anon-struct-literal-expected-type-ctor.md`, s2 SIGSEGV). An expected `Func` type therefore falls to `evaluate_anonymous_struct_value`.
TS `src/evaluator/calls/function.ts:447-467`:

```ts
if (functionName === "_") {
  const expectedType = context.expectedType;
  if (!expectedType || isSomeType(expectedType.type)) { ... return evaluateAnonymousStructValue(...); }
  functions = [{ type: typeOfType(expectedType.type), value: createTypeValue(expectedType.type) }];
```

PATCH (narrow widening, keeps the named-struct exclusion that caused the s2 crash):

```rust
if(
  (expected_is_anon_struct || is_function_type(et_ty)) && !(is_some_type(et_ty)),
```

plus `is_function_type` added to the `types/guards.yo` import at `_expr.yo:201`. **Measured: arm 14 hollow 1 → 0** (evaluator layer clean; the lambdas now emit as real C functions `yo_id_5940` / `yo_id_5945`).

### E — arm 9 = blk10, the recorded deep-predicate swap

`function.yo:1632/1636` `type_contains_some_type` → `type_contains_some_type_deep` + import at :89. **Measured: arm 9 hollow 1 → 0.** Confirms the recorded root exactly (the failing pair is `tuple_func :: (fn(generic(T,Y), x : Tuple(T,Y), a : T, b : Y) -> Tuple(T,Y))`, fn.test.yo:495-500).

**Validation performed:** all five applied to a copy at `scratchpad/t3/ys2`; `./yo-cli check ./scratchpad/t3/ys2` = **295/305**, the _identical_ file set as `./yo-cli check ./yo-self` on HEAD (same 10 known FAILEDs). Then compiled (`--release`, 2m48s) to `/tmp/t3all`. Diff saved at `scratchpad/t3/PATCH.diff` — **its last hunk (`function_type.yo`) is the debug probe, not part of the fix.**

## 3. THE TWO LAYERS STILL BEHIND fn

### arm 11 layer 2 — CTFE of a `recur`-using comptime fn yields no value

After patch A, arm 11's error becomes `Expected compile-time value for "result" … comptime_factorial(12)`. Sharp depth discriminator (`r/r11g{0,1,2}.test.yo`, all under `/tmp/t3alldbg`):

| `cf :: comptime_fn(fac); r :: cf(N)` | result   |
| ------------------------------------ | -------- |
| N=0 (no `recur` executed)            | hollow=0 |
| N=1                                  | hollow=1 |
| N=2                                  | hollow=1 |

So exactly one executed `recur` destroys the fold. `evaluate_recur`'s normal path (`recur.yo:227-236`) is a faithful port of `recur.ts:126-134`, so the loss is downstream. **Strongest lead:** `comptime_fn.yo:415` sets `out_info.value = Some(arg_val)` — the _original_ FuncVal, reusing the runtime `func_id`. TS builds a **new** `FunctionValue` at `ctfe-analysis.ts:159-172` with `type: comptimeFunctionType`, `funcId: \`${functionValue.funcId}\_comptime\`` and the *evaluated* body (`comptimeFunctionValue.body = evaluatedBody`, :201). yo-self shares one func_id between the runtime and comptime versions, so their comptime/specialization caches collide.

### arm 14 layer 2 — codegen emits the forward-referenced comptime fn variable by name

`.yo_selftest_batch_1.bin.c:2252`: `error: use of undeclared identifier 'is_odd'`, from

```c
bool _..._6633 = (((bool (*)(int32_t))is_odd)((int32_t)(_..._6631)));
```

Only the _first_ direction breaks (`is_odd` was declared-but-unassigned when `is_even`'s body was evaluated); the second lambda correctly calls `yo_id_5940`. TS emits forward declarations and concrete names (`/tmp/t3_p14b.c:1244,1247` → `fn_yo…_id_10_is_odd`, `fn_yo…_id_9_is_even`). This is a **codegen** root, distinct from D.

## 4. BLAST RADIUS — full `tests/` A/B, 96 files each, measured

`scratchpad/t3/sweep_head.txt` (`/tmp/sh172`) vs `scratchpad/t3/sweep_all.txt` (`/tmp/t3all`):

- HEAD: **89 GREEN / 7 HOLLOW / 0 RED** → patched: **88 GREEN / 7 HOLLOW / 1 RED**
- **Exactly two files changed status. 94 identical (same pass counts).**

1. `imm_map.test.yo` HOLLOW → **RED rc=134** — patch E, the already-documented `get_enum_variant_c_name` abort (`issues/retired/yo-self-hollow-root-cause-map.md`, commit `10bca26bc`). Reproduces on HEAD alone; not created by E.
2. `comptime.test.yo` GREEN → **HOLLOW** — patch B unmasks a **second** defect. Minimal repro (`scratchpad/t3/r/n6.test.yo`, 4 lines):

```rust
a :: i32(100);
neg_val :: -(i32(50));
neg_sum :: (neg_val + a);   // -> runtime-only unknown
```

Discriminators (all under `/tmp/t3alldbg`): `neg_val :: -(i32(50))` **alone** folds (n5 hollow=0); `a + b` from plain literals folds (n2 hollow=0); `a + neg_val` — operator-call result as the **argument** — folds (n7 hollow=0); `neg_val + a` — operator-call result as the **receiver** — does **not** (n6/n4/n1 hollow=1, f32 and i32 alike). So: a value produced by a prefix-operator `Call`-module call loses comptime-ness when it becomes the _receiver_ of an infix operator, i.e. the comptime overload loses in `_select_matching_overload` (`function.yo:585+`).

**Answer to the landing question:** yes — over all 96 `tests/` files the deep-predicate swap's only casualty is `imm_map`, so **E can land once the enum abort is fixed**. Patches A, C, D are regression-free on this corpus and can land now. **B must wait** on the operator-receiver defect above (or it trades fn arm 12 for comptime.test.yo).

## 5. CONFIDENCE + THE OPEN RESIDUALS

High on: the five arms and their five roots (each measured on an isolated single-arm file, TS ground-truthed, and flipped by a built binary); the two-file blast radius.

Two residuals, both cheap:

1. **E was not isolated in its own binary** — the 96-file sweep used all five patches together. A HEAD+E-only build (`scratchpad/t3/ysE` is already patched and `fmt`ed; the `--release` compile was still running under heavy machine load when I stopped) + a re-run of `scratchpad/t3/sweep.sh` is the single cheapest observation that settles it. I attribute the `comptime.test.yo` flip to B because B is the only patch touching that condition and the error text is literally the message B's condition gates — but that attribution is inferential, not isolated.
2. **Other agents were running `yo-cli` over the same tree during my sweeps** (5 concurrent `bun run src/yo-cli.ts` processes observed at 10:07). Batch artifacts live in the test file's own directory, so a concurrent `tests/` sweep could collide. Both of my sweeps were internally self-consistent and 94/96 identical, which argues against corruption, but a re-run of just the two changed files would confirm.

Artifacts (all absolute): probe binaries `/tmp/t3dbg` (HEAD + un-silenced swallow), `/tmp/t3all` (5 patches), `/tmp/t3alldbg` (5 patches + swallow). Patched tree `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/ys2`; diff `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/PATCH.diff`; per-arm files `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/arms/a{0..23}.test.yo`; repros `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/r/`; sweeps `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/sweep_{head,all}.txt`; helpers `/Users/yiyiwang/Workspace/Yo/scratchpad/t3/{hollow.sh,sweep.sh}`. No file under `yo-self/`, `src/`, `std/`, `tests/` was modified (`git status` shows only the pre-existing `M src/tests/fixme.yo`).
