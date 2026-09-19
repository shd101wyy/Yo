# An integer literal on the LEFT of a runtime operand is rejected

**Status:** OPEN
**Found:** 2026-09-19, during the LLM authoring audit
(`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §2.4)
**Repro:** `issues/repros/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.yo`
**Measured on:** tree `49d75c665`, `yo 0.2.36`, `--std-path ./std`

## Symptom

A bare integer literal converts to any runtime integer type when it is an
ARGUMENT — `xs.push(1)`, `n == 3`, `n + 1`, `Point(3, 4)` all check — but the
same literal on the left of a binary operator with a runtime right operand is
rejected, with an error that names a "compile-time parameter" the author
never wrote:

```
error: Cannot assign runtime argument to compile-time parameter "end"
   --> issues/repros/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.yo:23:12
   |
23 |   for(0 .. n, i => {
   |            ^
```

Three spellings, each measured in isolation with `n := usize(5)`:

| literal on the left | verdict | mirror image | verdict |
| --- | --- | --- | --- |
| `(0..n)` | rejected, parameter `end` | `(n..usize(9))` | accepted |
| `(3 == n)` | rejected, parameter `rhs` | `(n == 3)` | accepted |
| `(1 + n)` | rejected, parameter `rhs` | `(n + 1)` | accepted |

The second half of the same defect: a range whose BOTH ends are literals,
`(0..5)`, evaluates to `Range(comptime_int)`, and nothing implements
`into_iter` for it. So `for(0..5, i => …)` — the first loop any author
writes — fails too, and the message points INSIDE the prelude at the `for`
macro's expansion, blaming the macro for what the operand did:

```
error: No matching call found with arguments:
((0 .. 5).into_iter)()
     --> std/prelude.yo:9982:53
     |
9982 |                   unquote(iter_var) := unquote(coll).into_iter();
```

Neither failure is a `for` bug. `for(usize(0)..n, …)` and
`r := (usize(0)..n); for(r, …)` both work.

## Root cause (measured from the prelude, evaluator site still to locate)

Binary operators dispatch on the LEFT operand's type. `comptime_int`
implements only the comptime operator traits — `ComptimeRangeOp`,
`ComptimeAdd`, `ComptimeEq`, … (`std/prelude.yo` ~L1046 for the range op) —
whose parameters are all `comptime(...)`. With a runtime right operand there
is no impl whose parameter the operand can bind, hence "Cannot assign runtime
argument to compile-time parameter". When the literal is on the RIGHT, the
receiver is `usize`, its runtime `RangeOp`/`Add`/`Eq` impl takes
`rhs : usize`, and the literal converts at the argument position exactly as
the language promises.

So the `comptime_int → runtime int` conversion exists for arguments and is
missing for the receiver that selects the impl. The `(0..5)` half is the same
gap one step later: no runtime operand is present to convert TO, so the
result stays a comptime range that has no runtime iterator.

## Fix direction

1. In binary-operator dispatch, when the left operand is `comptime_int` (or
   `comptime_float`) and the right operand has a runtime numeric type,
   convert the literal to the right operand's type BEFORE selecting the impl
   — the mirror of what already happens for a literal argument. This closes
   all three rows of the table and the `for(0..n, …)` case.
2. For an all-literal range consumed at runtime (`for(0..5, …)`), do NOT
   guess a runtime type silently (maintainer rule 2026-09-19: explicit over
   implicit). Report it at the RANGE, not inside the prelude, with a repair:
   "`0..5` is a compile-time range with no runtime iterator; write
   `i32(0)..i32(5)`" — a `Repair` the `yo fix` channel can apply.

## Tests to add (fail before, pass after)

- `tests/range_literal_lhs.test.yo`: the three table rows plus
  `for(0..n, …)` summing to the expected value at runtime.
- `tests/cli-cases/check-comptime-range-has-no-runtime-iterator/`: the
  `for(0..5, …)` diagnostic, anchored at the user's range with the repair in
  `--error-format json`.
