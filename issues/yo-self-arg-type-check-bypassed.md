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

## Next step

Find which path handles a direct call to a top-level `FuncVal` and why it skips
argument checking — instrument the entry points in `evaluator/calls/function.yo`
(the FuncVal arm around :945 and the specialization shortcut in
`create_specialized_function`) to print when they dispatch without calling
`try_to_call_function_with_arguments`. TS funnels every call through
`tryToCallFunctionWithArguments`, so whichever yo-self path bypasses it is the
divergence.

## Why it matters beyond one reproducer

This is very likely the reason several `comptime_expect_error` tests fail: they
assert that a wrong-typed call is rejected, and yo-self accepts it. It also
means any "green" file could contain silently mistyped calls that C happens to
cast into place. Related: `issues/yo-self-hollow-test-batch-main.md` (one such
throw hollowes out an entire test file).
