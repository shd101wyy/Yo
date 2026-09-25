# `std/assert`'s `panic` cannot be used in a value arm because Yo has no bottom type

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** PARTIALLY FIXED 2026-09-25. The compiler half (Phase 3.6 of `plans/TYPE_SYSTEM_SOUNDNESS.md`)
landed: `never` exists, `__yo_panic` and any `-> never` function type a value arm. OPEN for the std half:
`std/assert`'s `panic`, `std/process`'s `exit` and libc's `exit`/`_Exit`/`quick_exit`/`abort` become
`-> never` once `SEED_VERSION` carries the `never` type (see "Remaining"). Completeness/design gap.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ panic } :: import("std/assert");
f :: (fn(flag : bool) -> i64)({
  x := cond(flag => i32(3), true => panic("boom"));
  i64(x)
});
main :: (fn() -> unit)({ f(true); () });
export(main);
```

`error[E0601]: Incompatible types: Previous: i32, Current: unit`, whichever arm comes first; the
same in `match`.

## Mechanism (READ)

`TypeValue` has no `Never` variant. `std/assert.yo`'s `panic` is declared `-> unit`. Only the
`__yo_panic` builtin borrows a stand-in type (the expected type, else the fn result type,
`src/evaluator/builtins/panic.yo` ~67); `return(...)` and `unwind(...)` arms are special-cased.

## Fix direction

Add a bottom type (`never`) that is compatible with every expected type and is the join identity
for `cond`/`match` arms. Type `return`, `unwind`, `__yo_panic`, `std/assert.panic`,
`unreachable`-style helpers and `exit` as `never`. Codegen must then emit a `never`-typed call in
value position as a statement followed by a C value placeholder or `__builtin_unreachable()`
(not yet measured how each backend path handles this).

## Fix (2026-09-25, compiler: Phase 3.6)

- `TypeValue.Never`, spelled `never` (`src/types/definitions.yo`, the builtin type names in
  `src/evaluator/exprs/identifer_and_operator.yo`); C lowers it to `void`.
- `src/types/compatibility.yo`: `never` flows into every type; as an identity it is only itself; nothing
  else flows into it (so a `-> never` body that completes is `Function body has type unit, but the
  declared result type is never`).
- `cond`/`match` (`src/evaluator/exprs/cond.yo`, `match.yo`): a `never` arm takes no part in the join;
  when every value arm is `never` the expression is `never`. The diverging arms then ADOPT the join's
  type (`adopt_never_type`, `src/evaluator/utils.yo`), and a body's `never` tail adopts the declared
  result (the concrete and the specialization body checks), so codegen still has a real type for the
  unreachable placeholder.
- `__yo_panic` is `never` when nothing is expected of it. It used to borrow the enclosing function's
  result type, which is how the repro became "Previous: i32, Current: unit" (and, with
  `__yo_panic` in an `-> i64` function, "Previous: i32, Current: i64").
- Codegen: a call to a `-> never` function runs as a statement and leaves the adopted type's
  unreachable placeholder (`_generate_expr`, `src/codegen/exprs/generation.yo`); no temp is bound to a
  `never` value.

`tests/type_soundness.test.yo`: the arm shapes (`cond`, `match`, a `-> never` call, a tail, a
statement), `Type.eq(never, never)`, the flow direction, and the `-> never` body that returns.

## Remaining: the std declarations wait for the seed

`yo build` compiles `src/` with the tree's `std/` using the SEED compiler (`SEED_VERSION`), and the
v0.2.42 seed has no `never`. Declaring `std/assert.yo`'s `panic` `-> never` today would break the
build (plans/backlog/SEED_VERSION_AUTOMATION.md; the same gate as a new `std/build.yo` builtin). The
change is small and ready:

- `std/assert.yo`: `panic :: (fn(generic(T : Type), msg : T, where(T <: ToString)) -> never)`, with the
  final `match` as the tail (drop the trailing `()`);
- `std/process/index.yo`: `exit :: (fn(code : usize) -> never)` with `unsafe(_exit(int(code)))` as the
  tail;
- `std/libc/stdlib.yo`: `exit`, `quick_exit`, `_Exit`, `abort` return `never`.

Land it in the first PR after a release whose seed carries Phase 3.6, together with the original
repro above as a test.
