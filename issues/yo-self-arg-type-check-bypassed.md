# yo-self accepts a type-incompatible argument and emits a silent C cast

**Status:** OPEN, found 2026-07-26 on HEAD (`ccd2dc498`).
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

## Next step

Find why the callee type is not resolved to the function's `Func` type on that
branch: print `callee_ty_none` at `function.yo:4433` for the reproducer. Either
the atom lookup for `f` yields a non-`Func` (so the fix is in the lookup), or
the branch is chosen when a `FuncVal` was in fact available (so the fix is the
branch condition). TS has no valueless-callee shortcut — every call goes through
`tryToCallFunctionWithArguments` with the resolved function type — so whichever
it is, the repair is to route this branch through the same check. Suggested probe: print the callee `func_id` at every site
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
