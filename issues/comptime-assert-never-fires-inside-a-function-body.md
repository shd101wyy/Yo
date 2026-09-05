# `comptime_assert` never fires inside a function body — 1559 assertions in `tests/` assert nothing

**Status: OPEN.**

**Severity: hollow gate.** Not a wrong answer — an *absent* answer, over the
entire compile-time-evaluation surface. `comptime_assert` is the only mechanism
the suite has for pinning CTFE results, and it is inert everywhere the suite
uses it.

**Found** 2026-09-04, while writing a regression test for
`issues/fixed/comptime-u64-div-mod-cmp-shr-are-signed.md`. The new test passed
on the *unfixed* compiler, which is how the vacuity surfaced.

## Reproducer

```rust
main :: (fn() -> unit)({
  comptime_assert(false);
});
export(main);
```

```
$ yo compile ca1.yo --optimize 2 -o ca1.out
$ echo $?
0
```

Accepted. At module level the same call is correctly rejected:

```rust
comptime_assert(false);
main :: (fn() -> unit)({});
export(main);
```

```
error[E1101]: Assertion failed for "comptime_assert":
false
  --> ca2.yo:1:1
  |
1 | comptime_assert(false);
```

Measured on v0.2.24, `comptime_assert(false)` in each position:

| position | result |
| --- | --- |
| module level | **REJECTED** (E1101) — correct |
| inside `main`'s body | accepted, silently |
| inside a plain `fn` that IS called from `main` | accepted, silently |
| inside a plain `fn` that is never called | accepted, silently |
| inside a `fn(...) -> comptime(T)` body | accepted, silently |

`yo check` accepts it in every position including module level, but that is
expected: `check` is evaluator-only and this diagnostic is raised on the
compile path.

## Scale

A `test("name", { ... })` body **is** a function body, so every
`comptime_assert` in the suite is in the inert position:

```
$ grep -rh 'comptime_assert' tests/ | wc -l
1559
$ grep -rc 'comptime_assert' tests/*.test.yo | sort -t: -k2 -rn | head -5
tests/comptime.test.yo:1064
tests/basic.test.yo:172
tests/type_reflection.test.yo:103
tests/index.test.yo:58
tests/variadic_comptime.test.yo:34
```

`tests/comptime.test.yo` is the primary gate on constant folding, comptime
strings, comptime collections and type reflection. It reports 31 passing tests
and verifies none of their comptime claims.

This is exactly how the u64 signed-arithmetic bug above survived: `Test
comptime u64` contains `comptime_assert(quot == …)` lines that would have
caught a mis-folded division if they had run.

## Why this matters beyond the count

Two of the audit's own conventions lean on `comptime_assert`:

- the O7 `Acyclic` pins use `comptime_assert(Type.impls(payload, Send))` to
  guarantee "the expected error can only be Acyclic's"
  (`plans/STD_API_AUDIT.md` §8 O7) — an inert guard there means the
  `comptime_expect_error` tests may be passing for the wrong reason;
- `std/prelude.yo`'s own `for`-macro validation uses
  `comptime_assert(args.len() == 2, …)` inside a macro body, which is a
  function body.

## Root cause — not yet established

Not yet root-caused; this doc is the filing, not the fix. What is known:

- the diagnostic is `E1101` and is reachable, so the check exists and the
  message is wired;
- position is what decides, not reachability — an uncalled function behaves the
  same as `main`, which rules out "the body was never evaluated" as the whole
  story;
- the shape strongly resembles the **def-eval swallow** family already
  documented in this repo, where a real error raised during a function's
  definition-time trial evaluation is caught and discarded. C18 and C19 were
  both this: *"the check FIRED but was SWALLOWED in async-closure/generic
  def-eval, leaving codegen no ExprInfo"*, and the fix there was to flag the
  flow-violation channel before throwing so the swallow re-raises it at check
  time (`issues/fixed/struct-literal-missing-field-silently-accepted.md`,
  `issues/fixed/int-vs-i32-mismatch-reaches-codegen-and-emits-malformed-c.md`).

Start there: find where `comptime_assert` is evaluated (the builtin dispatch in
`src/evaluator/builtins/`), and find which handler swallows its throw when the
enclosing expression is a function body rather than a module-level statement.

## Fix shape

1. Make `comptime_assert` fire in a function body, by the same
   flow-violation-channel route C18/C19 used, so the def-eval trial cannot
   discard it.
2. **Then triage the fallout.** Turning on 1559 dormant assertions will go red
   in places, and every red one is either a real bug or a stale assertion. That
   triage is the substance of this work, not a side effect — budget for it, and
   do not weaken assertions to get green. Land the fix and the triage together
   so the suite is never knowingly hollow on `develop`.
3. Add a **vacuity guard** so this cannot regress: a test that asserts
   `comptime_assert(false)` inside a function body is REJECTED. The natural
   home is a `tests/cli-cases/` golden (a compile that must fail with E1101),
   since the assertion is about a compile failing.

## Interim guidance for test authors

Until this is fixed, do not rely on `comptime_assert` inside a `test(...)`
body. The shape that works today is a **module-level `::` binding observed by a
runtime `assert`**: the binding is folded at comptime, and the runtime assert
observes what the folder produced. `tests/comptime.test.yo`'s three new
`UNSIGNED` tests are written that way and are verified to go red on a broken
compiler.
