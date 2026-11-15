# Under `verify+`, a function with a `requires`, no `ensures` and a block body is not verified

**Severity:** S2 — in a `Pragma.VerifyOrAssert` module every function that states a precondition, has no postcondition and has more than one statement is reported `subset` and proves nothing, where `Pragma.Verify` verifies the same function; `yo verify --strict` fails on it.

Filed 2026-11-15 while measuring the cost of
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../plans/backlog/DEFAULT_ON_VERIFICATION.md),
which makes `verify+` the default mode. Reproduced with `yo 0.2.77` and with a
build of `origin/develop` merged into `fix/sig-1` (`5c1b9c056`, 2026-11-15),
Z3 5.1.0.

## Reproducer

[`repros/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.yo`](repros/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.yo):

```yo
pragma(Pragma.VerifyOrAssert);
{ println } :: import("std/fmt");

inc :: (fn(x : i32, requires(x < i32(100))) -> i32)(x + i32(1));

block :: (fn(x : i32, requires(x < i32(50))) -> i32)({
  v := inc(x);
  v
});

expr :: (fn(x : i32, requires(x < i32(50))) -> i32)(inc(x));

main :: (fn() -> unit)({
  println(block(i32(3)) + expr(i32(3)));
});
export(main);
```

`block` and `expr` are the same function.

## What happens

`yo check` on the file:

```text
  ok       fn@…:10 [verify+] — no obligations
  subset   fn@…:12 [verify+] — cannot verify: the body's definition-time evaluation did not complete (its error was swallowed at load — run yo check on the file for the underlying cause)
           begin(v := inc(x), v)
           (verify+ fallback: the runtime assert stays)
  ok       fn@…:17 [verify+] — 1 obligation(s) proved
```

- `block` (line 12) is not walked, so its call to `inc` is not checked against
  `inc`'s `requires`. `expr` (line 17) proves it.
- The message sends the reader to `yo check`, which is the command that
  printed it and which reports no error. `YO_DEBUG_SWALLOW=1 yo check` prints
  the same swallowed errors with and without `block` in the file, so the
  "underlying cause" cannot be recovered from any output.
- The program compiles and runs correctly (it prints `8`). Only the proof is
  lost.
- `yo verify <file> --strict` counts it: `1 subset-error`.

With the pragma changed to `Pragma.Verify`, both functions prove:

```text
  ok       fn@…:12 [verify] — 1 obligation(s) proved
  ok       fn@…:17 [verify] — 1 obligation(s) proved
```

## What triggers it

Each row is one function in a `Pragma.VerifyOrAssert` file, measured on
`yo 0.2.77` and on the develop build above. `note` and `plain` have no
contract.

| Function | Outcome |
| --- | --- |
| `requires`, no `ensures`; body `{ v := x; v }` | **subset** |
| `requires`, no `ensures`; body `{ note(x); x }` (no binding) | **subset** |
| `requires`, no `ensures`; body `{ (mut(v) : i32) = x; v = (v + i32(1)); v }` | **subset** |
| `requires`, no `ensures`, result `unit`; body `{ v := x; note(v); }` | **subset** |
| `requires`, no `ensures`; body `{ v := plain(x); v }` | **subset** |
| `requires`, no `ensures`; a single-expression body (`plain(x)`, `inc(x) + i32(0)`) | ok |
| `requires` **and** `ensures`; body `{ v := x; v }` | ok |
| no `requires`; body `{ v := inc(x); v }` | walked (its call is refuted, correctly) |
| any of the above under `Pragma.Verify` | ok |

So the trigger is the conjunction of `verify+` mode, a `requires` with no
`ensures`, and a body of more than one statement. Neither the callee nor the
binding matters.

## Root cause

Not run to ground. The two modes differ in what the evaluator does with a
function's contracts: `verify` suppresses the runtime asserts, `verify+`
splices them and strips them after a proof. The report comes from the path
that finds the body without `ExprInfo` after its definition-time trial (the
`record_verify_task_def_eval_failure` site in
`src/evaluator/calls/function_type.yo` and the driver's consult of it), so the
`requires`-only wrapper spliced around a `begin` body is the place to look:
with an `ensures` present the wrapper takes a different shape and the body is
walked.

## Why it matters now

`verify+` is the mode DEFAULT_ON_VERIFICATION makes the default, and it is the
least tested one: of the fixtures under `tests/spec/fixtures/valid/`, one
(`verifyplus_abs.yo`) uses `Pragma.VerifyOrAssert`. Step S1 of that plan
scaffolds this pragma into every new project.

## Fix, and its test

- Make `block` prove under `verify+` as it does under `verify`.
- Whatever the cause, the diagnostic must name it, or at least must not point
  at a command that prints nothing.
- Tests: the reproducer as a fixture under `tests/spec/fixtures/valid/`,
  expecting two proved functions; and a sweep that runs every fixture of that
  directory in both modes and requires the same set of proved functions, which
  is the gate that would have caught this.
