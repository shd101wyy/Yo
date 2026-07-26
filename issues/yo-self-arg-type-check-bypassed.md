# yo-self accepts a type-incompatible argument and emits a silent C cast

**Status:** FIX WRITTEN + TIER-1 CLEAN; **NOT LANDED** — reverted from the tree
so the `forall` → `generic` migration (`plans/FORALL_TO_GENERIC.md`) could start
from a clean base, as that plan's Timing rule requires ("Any in-flight yo-self
work must be committed or reverted first"). TIER-2 was stopped ~10 min into
stage2 and never completed, so the fixpoint is UNVERIFIED.

**To resume:** `git apply issues/patches/arg-type-check-fix.patch` (93 added
lines, one file: `yo-self/evaluator/calls/function.yo`). It will need rebasing
onto the rename — mechanical, the patch context contains no `forall` binder —
then re-run TIER 1 and a full TIER 2.
**Severity:** a core soundness hole — the callee's parameter type is not
enforced on some call path, and codegen papers over it with a C cast.

## Reproducer

```rust
open(import("std/fmt"));
f :: (fn(x : i32) -> i32)(x);
main :: (fn() -> unit)({
  println(`${f(true)}`);
});
export(main);
```

| compiler | result                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| TS       | **rc=1** — `Failed to synthesize types for parameter "x": Cannot unify incompatible types: Expected "i32", Given "bool"` |
| yo-self  | **rc=0**, and emits `int32_t _t = yo_id_4992((int32_t)(true));`                                                          |

The `(int32_t)(true)` cast is inserted by codegen; nothing in the evaluator
objected.

## What is NOT the cause

- **`are_types_compatible` is correct.** `types/compatibility.yo:347-355` has an
  early tag-mismatch return plus `.BoolT => match(expected, .BoolT => true, _ => false)`,
  so `are_types_compatible(i32, bool)` is `false`.
- **The comptime-arg coercion is not involved** (`helper.yo:524-556`): it only
  fires for `comptime_int` / `comptime_float` / `comptime_string` sources, and
  `true` is a plain `bool`.
- **The inherent-first method filter is correct.** For the original symptom
  (`tests/inherent_first_resolution`, where an inherent `m(i32)` must shadow a
  trait `Bar::m(bool)`), instrumentation shows both candidates present with the
  right provenance — `trait_id=""` and `trait_id="trait_yo_id_4995"` — so the
  filter at `env.yo:3279-3315` does drop the trait one. The call then succeeds
  anyway, because of THIS bug.

## What IS measured

`check_and_add_argument`'s Step-8 compatibility check
(`evaluator/calls/helper.yo`, `if(!(are_types_compatible(final_pt, arg_type)))`)
was instrumented to print every `param_label == "x"` pair while compiling the
reproducer. Output contains **25 distinct `final_pt`/`arg` pairs, every one of
them equal and compatible** (`i32/i32`, `bool/bool`, `usize/usize`, …) — and
**no `final_pt=i32 arg=bool` line at all**.

So the argument never reaches the per-argument check: `f(true)` is dispatched
through a call path that does not run `check_and_add_argument`.

## Both known dispatch paths are ruled out (measured)

Instrumented at the entry of each, compiling this reproducer:

| path                                                   | fires for `f(true)`?                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `try_to_call_function_with_arguments` (helper.yo:2541) | **NO** — over the whole compile it is never entered with a `fn(x : i32)` type (only `fn(self : i32) -> String`, i.e. `to_string` on the result) |
| `evaluate_comptime_fn_call` (comptime_fn.yo:382)       | **NO** — it is entered 1167 times (prelude), never with `fid=yo_id_4992`, the id the emitted call uses (`yo_id_4992((int32_t)(true))`)          |

So a THIRD dispatch path handles a direct call to a module-level `FuncVal`, and
that path performs no argument checking.

## Narrowed further (2026-07-26, second session pass)

Probing the call evaluator itself:

| probe                                                                                                 | result                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate_function_call` entry, filtered to callee atom `f`                                           | **fires** — the call IS evaluated by the normal entry                                                                                   |
| the 5 `try_to_call_function_with_arguments` sites in `function.yo`, each tagged                       | **site 5 fires** immediately after it (`function.yo:4433`, the VALUELESS-callee branch that passes `func_val = Option(EvalValue).None`) |
| `try_to_call_function_with_arguments` entry, filtered to a `func_type` rendering containing `x : i32` | **never fires**                                                                                                                         |
| `check_if_function_parameter_matches_argument` entry, filtered to `resolved_pt == "i32"`              | prints only `label=self` and `label=y` — **never `label=x`**                                                                            |

So the sequence is: the call reaches `evaluate_function_call`, is dispatched
through the valueless-callee branch at `function.yo:4433`, and the
`func_type` handed to `try_to_call_function_with_arguments` is **not** the
callee's `fn(x : i32) -> i32`. The parameter loop lives inside
`match(func_type, .Func({…}) => { … })` (helper.yo:2603), so with a non-`Func`
type there is nothing to check and every argument is accepted.

Also ruled out: it is not literal-specific coercion — binding `b := true` first
and calling `f(b)` is accepted just the same (TS rejects both).

## Correction — it is site 4, not site 5 (the earlier read was a name collision)

The first pass filtered the entry probe on the callee atom being named `f`, but
**the prelude also has an `f`** (`fn(acc : comptime_str, i : usize) -> comptime_str`,
the fold/template helper), and that is what produced the `TTCSITE 5` hit. Filtering
exactly — callee named `f` AND first argument the atom `true` — gives the real
trace:

```
__DBG_CALL entry callee=f arg=true      <- our call, 1st evaluation
__DBG_TTCSITE 4                          <- function.yo:4215, the .method() arm
__DBG_CALL entry callee=f arg=true      <- our call, 2nd evaluation
__DBG_P0 label=self pt=i32 arg_in=i32    <- to_string(self : i32) on the RESULT
__DBG_TTCSITE 4
```

So `f(true)` is dispatched through the **method arm** at `function.yo:4215`, and
the `func_type` handed to `try_to_call_function_with_arguments` there is NOT
`fn(x : i32) -> i32` (the TTC entry probe filtered on that rendering never
fires). With a non-`Func` type the parameter loop at `helper.yo:2603` has
nothing to iterate, so the argument is never checked. The valueless-callee
branch at `function.yo:4433` is NOT involved — its probe only ever fired for the
prelude's `f`.

**Lesson for the next probe: never filter a trace on a bare identifier name.**
The prelude defines short names (`f`, `x`, `m`) that collide with anything a
reproducer uses; filter on a shape unique to the reproducer, or on
`ast_expr_token(expr).module_path`.

## LOCATED — `_evaluate_funcval_runtime_call` (function.yo:1347-1674)

Tagging every `return` inside `evaluate_function_call` and filtering exactly
(callee `f` AND first arg the atom `true`) shows the call exits through:

```
__DBG_CALL entry callee=f arg=true
__DBG_RETX funcval_runtime_call      <- function.yo:3894
```

`_evaluate_funcval_runtime_call` is the runtime-return branch of the FuncVal
arm, entered whenever the callee's return is neither a `Type` nor comptime —
i.e. for most ordinary calls. Its header calls it "pure code motion" from
`evaluate_function_call`, extracted for -O0 frame size. Over its **327 lines**:

| symbol                                         | occurrences          |
| ---------------------------------------------- | -------------------- |
| `try_to_call_function_with_arguments`          | **0**                |
| `check_if_function_parameter_matches_argument` | 1 — **in a comment** |
| `are_types_compatible`                         | **0**                |
| `synthesize_types`                             | **0**                |

It mirrors only that function's Step-4 comptime coercion. No argument is ever
checked against its parameter type. (The earlier "method arm at
`function.yo:4215`" reading was another adjacent-line artifact — that site's own
probe never fires for this call.)

## Attempted fix and why it did not fire — read before retrying

A conservative check was added inside the branch's per-argument loop
(`while(sra_i < n_supplied_reg, …)`, function.yo:1583), guarded to only fire
when the declared param count equals the supplied count and the declared type is
concrete. **It never executed**: a debug print at the top of that loop produces
no output for the reproducer.

Reason: that loop builds the SPECIALIZATION argument list, and `f` is
NON-GENERIC — there is nothing to specialize, so the branch skips the loop
entirely and emits the call directly.

So the check must go **outside** the specialization loop, on a path that runs
for every call this branch handles, generic or not. Before writing it, find
where this branch walks the arguments unconditionally (or add such a walk), and
keep the same three guards (count alignment, concrete declared type,
post-comptime-coercion) — they are what keep it off the generic paths.

## Fix

A per-argument compatibility check on the UNCONDITIONAL path of
`_evaluate_funcval_runtime_call` (top of the function, before the return-type
resolution), guarded to stay off every path where the binding is made
elsewhere:

- declared parameter count == evaluated argument count (unambiguous alignment —
  receiver / implicit / defaulted params otherwise shift the indices);
- declared parameter type concrete: not a SomeT, not `type_contains_some_type`,
  **and not a function type**;
- argument type concrete: same three, and not `comptime_int/float/string`
  (those are lowered further down).

The function-type guard is load-bearing and was found by measurement, not
foresight. `type_contains_some_type` does NOT see through a `Func`, so a
callback parameter like `fn(e : E2) -> T2` reads as concrete and the check
rejected three legitimate effect-polymorphic calls:

```
expected=fn(e : E2) -> T2   given=fn(e : LogBundle) -> unit
expected=fn(e : E1) -> T1   given=fn(e : RaiseBundle) -> i32
expected=fn(e : E)  -> T    given=fn(e : RaiseBundle) -> i32
```

Without it: `async_await` rc=1, corpus PASS 139 / **DIFF 1**
(`effect_polymorphism_forall_infer`). With it: both clean.

### TIER-1 result (`scratchpad/gates_fast.sh`)

| gate             | result                                                        |
| ---------------- | ------------------------------------------------------------- |
| reproducer       | now REJECTED (statement no longer emitted with a silent cast) |
| battery 20 files | all counts AND all hollow flags identical to HEAD             |
| corpus           | PASS 140 / DIFF 0                                             |
| `check ./std`    | 153/153                                                       |

`sys/bufio` SIGSEGV'd once in the battery run; it reproduces on HEAD too (it is
already RED with rc=139 in the 183-file sweep). Re-ran it 6× with the fix
(5 clean, 1 rc=139 with a **zero-byte log** = the documented phantom-kill
signature) and 5× on HEAD (5 clean). Treated as machine flakiness, not a
regression — but worth re-checking if it recurs.

**This fix flips no test by itself** — the battery's hollow set is unchanged. It
closes a soundness hole; the `comptime_expect_error` files each need their own
missing validation on top. Suggested probe: print the callee `func_id` at every site
in `evaluator/calls/function.yo` that produces a `FuncCallResult` without going
through `try_to_call_function_with_arguments` (the FuncVal arm around :945, the
`.method()` arm around :2856, and the specialization shortcuts), and match it
against `yo_id_4992`. TS funnels EVERY call through
`tryToCallFunctionWithArguments`, so whichever yo-self path bypasses it is the
divergence — and the repair is to route it through the same argument check
rather than to add a second, parallel check.

## Why it matters beyond one reproducer

This is very likely the reason several `comptime_expect_error` tests fail: they
assert that a wrong-typed call is rejected, and yo-self accepts it. It also
means any "green" file could contain silently mistyped calls that C happens to
cast into place. Related: `issues/yo-self-hollow-test-batch-main.md` (one such
throw hollowes out an entire test file).
