# Under `verify+`, a function with a `requires`, no `ensures` and a block body is not verified

**Severity:** S2 — in a `Pragma.VerifyOrAssert` module every function that states a precondition, has no postcondition and has more than one statement is reported `subset` and proves nothing, where `Pragma.Verify` verifies the same function; `yo verify --strict` fails on it.

Filed 2026-11-15 while measuring the cost of
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../../plans/backlog/DEFAULT_ON_VERIFICATION.md),
which makes `verify+` the default mode. Reproduced with `yo 0.2.77` and with a
build of `origin/develop` merged into `fix/sig-1` (`5c1b9c056`, 2026-11-15),
Z3 5.1.0.

- Status: FIXED by the `wip/v0281-dov-s0` branch (DEFAULT_ON_VERIFICATION step S0).
  Reproduced before the fix with the v0.2.79 seed on `a471c290c`.

## Reproducer

[`repros/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.yo`](../repros/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.yo):

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

Not the definition-time trial: nothing was swallowed, which is why no command
could print an "underlying cause". The body node the verifier walks was never
evaluated at all.

`wrap_function_body_with_contracts` (`src/evaluator/builtins/contracts.yo`)
splices a function's contract asserts into its body. With no `ensures` to
splice, it builds `begin(<requires asserts>, <body>)`, and when the body is
itself a `begin` it FLATTENS it: the body's statements become arguments of the
new `begin`, and the body's own `begin` node is dropped. The evaluator then
stamps `ExprInfo` on the statements but never on the dropped node. The
`VerifyTask` carries the UNWRAPPED body (that dropped node), and the walk
(`src/verifier/vc.yo`) finds its root untyped and fails the subset.

`verify` mode already turned the flattening off (`flatten_body = false`, added
with the verify-mode entry asserts). `verify+` did not, so the trigger was
exactly: `verify+`, a requires-only splice (no `ensures`, or only proof-only
ones such as a quantified `ensures`), and a block body. A single-expression
body is pushed whole, and an `ensures` wrapper binds the whole body, so both
kept the node.

## Why it matters now

`verify+` is the mode DEFAULT_ON_VERIFICATION makes the default, and it is the
least tested one: of the fixtures under `tests/spec/fixtures/valid/`, one
(`verifyplus_abs.yo`) uses `Pragma.VerifyOrAssert`. Step S1 of that plan
scaffolds this pragma into every new project.

## Fix

- `wrap_function_body_with_contracts` does not flatten in `verify` or
  `verify+` mode, the two modes that register a `VerifyTask`. Runtime mode
  still flattens (no task walks the node there).
- The walk's message for an untyped root no longer sends the reader to `yo
  check`. A trial that swallowed an error is reported by the driver with the
  recorded message before the walk, so the walk's own message is reached only
  when no error was recorded, and it now says that: "the body carries no type
  information: its definition-time evaluation did not reach the body node and
  recorded no error (a compiler defect)".

## Tests

- `tests/spec/fixtures/valid/verifyplus-requires-block.yo`: the reproducer
  (`block`, `expr`), a unit-result block body, and a block body whose only
  `ensures` is quantified (the block-body half of
  `issues/2026-11-22-a-quantified-contract-clause-compiles-only-under-pragma-verify.md`).
  Before the fix `yo verify` reports 3 `subset-error`; after it, 5 `ok`.
- `scripts/verify-both-modes.py`, run by the formal-verification job's harness
  leg: every fixture of `tests/spec/fixtures/valid/` under `Pragma.Verify` and
  under `Pragma.VerifyOrAssert` must prove the same set of functions. It
  reports this fixture as diverging before the fix.
