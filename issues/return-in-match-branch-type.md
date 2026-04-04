# Return in match branch not treated as bottom/never type

## Status: Fixed

## Problem

When using `return` inside a match branch wrapped in a begin block `{ }`, the branch type is `unit` instead of a bottom/never type. This means the match arms have incompatible types even though the `return` branch never produces a value.

## Root cause

In `src/evaluator/exprs/match.ts`, three match evaluation paths checked type compatibility BEFORE checking for control flow (`return`/`escape`/`break`/`continue`). Branches with control flow should be treated as "never" type and skipped from type checking, matching the existing behavior in `cond.ts`.

## Fix

Moved `hasAnyControlFlow()` checks before `areTypesCompatible()` checks in all three match evaluation paths:

1. Enum variant match (line ~460)
2. Enum variant match secondary check (line ~528)
3. Primitive/wildcard match (line ~1566)

Also moved the type compatibility error inside the `else` branch of the control flow check, so branches with `return`/`escape`/`break`/`continue` are never type-checked against expected types.

## Test

Added test "return in match branch type compatibility" to `tests/basic.test.yo`.
