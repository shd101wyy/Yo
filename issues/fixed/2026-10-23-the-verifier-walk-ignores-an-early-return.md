# Verifier: the walk ignores an early `return`, so the value after its branch stands for the returned one

**Severity:** S1 — `yo verify --strict` reports `ok` for a false `ensures` (and a verify-mode `yo compile` erases its runtime check) when a branch returns a literal early: `if(c, { return(i32(5)); }); i32(0)` proves `ensures(r == i32(0))`.

- **Status:** fixed (filed and fixed 2026-10-23; review finding 1 on the
  call-site frame fix,
  `issues/fixed/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.md`).
- **Component:** `src/verifier/vc.yo`, `_expr_term`.
- **Measured with:** a develop build at `ef153b749` (the `cond`/`if` form) and
  the frame fix's branch at `2812fc2fa` (the `match` form too).

## Reproducer

`tests/spec/fixtures/negative/early_return_in_branch.yo`:

```yo ignore
r_if :: (fn(x : i32, requires(x >= i32(0), x <= i32(10)), ensures(r == i32(0))) -> (r : i32))({
  if(x == i32(1), {
    return(i32(5));
  });
  i32(0)
});
```

`r_if(1)` returns 5; develop reports `ok fn@...: 1 obligation(s) proved`.
The `match` twin `r_match` (`1 => { return(i32(5)); }, _ => { y = i32(2); }`,
then `y`, with `ensures((x != i32(1)) || (r == i32(0)))`) was refuted on
develop only by accident: develop let the `_` arm's write to `y` leak onto
the `1` arm's path
(`issues/fixed/2026-10-23-a-write-in-one-match-arm-holds-on-every-path.md`).
Once the arms merge correctly it proved too.

## Root cause

The walk has no rule for `return`. A `return(v)` whose argument the
evaluator folded to a constant has a comptime value, so `_expr_term`'s
folded-literal shortcut read it as the bare literal `v`, and a returning
arm became an arm whose value nobody uses. The path after the branch was
walked as if every path reached it, and the ensures was proved only for the
fall-through value. A `return(v)` with a runtime argument was already a
subset error ("call to an uncontracted, untyped callee"), which is why only
the folded form was a hole.

## Fix

A `return(...)` is outside the subset wherever it appears: `_expr_term`
fails the walk with `return(...) (an early exit: the walk does not model
the returning path)` before the folded-literal shortcut. That makes the
folded case agree with the runtime-argument case. Modeling the returning
path (prove the ensures at the return under its path condition, then mark
the path dead the way `break` does) is the precise rule and is left for
later. No verified function in `std/` or `tests/spec/` uses `return`.

## Test

The fixture above: both functions are subset errors. Pinned in
`tests/internal/verifier_list_len.test.yo` ("an early return is outside the
subset").
