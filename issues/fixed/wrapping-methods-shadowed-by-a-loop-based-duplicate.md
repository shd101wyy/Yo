# `wrapping_*` were shadowed by a loop-based duplicate: `yo check` 4x slower in v0.2.40

**Status: FIXED 2026-09-24** (branch `fix/wrapping-methods-shadowed-by-loops`).

## Symptom

v0.2.40 checks about 4x slower than v0.2.39. Measured on a Mac Mini M4, user
time:

| | `check ./src/lexer.yo` | `check ./src/parser.yo` | `yo build` (this tree) |
| --- | --- | --- | --- |
| v0.2.39 | 3.4 s | 3.7 s | 285 s |
| v0.2.40 | 13.7 s | 15.0 s | 607 s |

The regression is in the compiler binary, not std. The v0.2.39 binary is fast
with v0.2.40's std, and the v0.2.40 binary is slow with v0.2.39's std.

## Bisect

`git bisect run` over `v0.2.39..5498dd70b -- src` built each step with the
v0.2.39 seed and timed `check ./src/lexer.yo` against a fixed std. The first
bad commit is **`3cdb0fd44` (#841)**:

| commit | user time |
| --- | --- |
| f76780f8a (#837) | 3.33 s |
| 7e0187d59 (#849) | 3.40 s |
| 3cdb0fd44 (#841) | 14.28 s |
| 4c14fe529 (#847) | 14.31 s |

## Root cause

The prelude had **two** blanket impls over `where(T <: Integer)` that both
defined `wrapping_add` / `wrapping_sub` / `wrapping_mul`:

1. The Integer battery, rewritten by #841 as loops so that no intermediate
   could trip the new overflow traps: a bitwise carry loop for add and sub,
   and `checked_mul` followed by a Russian-peasant fallback over
   `wrapping_add` for mul.
2. The safe-mode 3a-i block (#837), where each method is one
   `__yo_op_*_wrap` builtin.

Two blanket impls over the same bound do not collide. The first one in the
file silently wins dispatch (the class in
`issues/fixed/an-overlapping-blanket-trait-impl-is-silently-dead.md`), so the
builtins never ran. #841 also moved `std/collections/hash_map.yo`'s
`mix_u64` (murmur3 fmix64, run on every HashMap key) onto `wrapping_mul`. Its
constants always overflow, so every hash took the fallback: up to 64
iterations, each a carry loop. A microbenchmark measured about 330 ns per u64
`wrapping_mul` + `wrapping_add` step, against about 1 ns for the builtin. The
compiler is built on HashMap, so `check` slowed about 4x overall.

The builtin path had never run, and it hid a second bug. The codegen emitted
a bare `(a + b)` with no narrowing, so under C integer promotion
`u8(250).wrapping_add(u8(10))` evaluated to 260.

## Fix

- The loop copies are deleted, leaving the builtin block as the only
  definition. That block moves up to just after the `Integer` impls, ahead
  of every user (`_popcount_u64`, `overflowing_*`, `wrapping_pow`). Placed
  after them, a def-time evaluation read `v.wrapping_mul(...)` as a Type
  value.
- `_wrap_binop` (`src/codegen/exprs/inline_fns.yo`) computes in
  `unsigned long long` and casts back to the result's C type. That is modular
  at every width, defined without relying on `-fwrapv`, and correct for
  signed operands because add, sub and mul produce the same low bits.

## Regression test

`tests/int_checked_arithmetic.test.yo`, "wrapping_mul and wrapping_add are
the builtin ops, not loops", times 10M u64 steps against a 1 s bound (about
3.3 s with the loop copy, a few ms with the builtin). Before the fix it fails
with the bound's message; after the fix it passes. The file's existing
narrow-width wrap tests (`u8 250+10`, `16*16` in a u8, `MIN+(-1)`) pin the
narrowing, because they failed the first time the builtins were actually
reached.

## Follow-up (open)

Two blanket inherent impls defining the same method name should be a compile
error, as a duplicate `impl(T, m)` already is. The duplicate gate in
`src/evaluator/values/impl.yo` skips generic receivers (`recv_id == ""`).
The key needs the bound as well as the name, so that blanket impls over
*different* bounds stay legal. Recorded in
`issues/fixed/an-overlapping-blanket-trait-impl-is-silently-dead.md`.
