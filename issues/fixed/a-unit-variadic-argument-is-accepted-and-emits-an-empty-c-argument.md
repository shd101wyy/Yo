# A unit variadic argument is accepted at check and emits an empty C argument

Status: FIXED 2026-09-28 (branch `fix/async-cond-tail-value`; found during the
Windows async-I/O performance pass, PR #974, while building a timing demo).

## Reproducer (tmp/fixme.yo shape)

```rust
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");

main :: (fn() -> unit)({
  unsafe(printf("%d\n", ()));
});
export(main);
```

and the shape it was found through — an awaited task whose block body ends in
a value-producing expression FOLLOWED BY `;`:

```rust
task := io.async((io : Io) => {
  io.await(sleep(Duration.from_millis(i64(1)), io), io);
  cond(true => i32(7), true => i32(0));   // trailing ; → the body's value is unit
});
io.spawn(task, io);
v := io.await(task, io);                  // v : unit, by design
unsafe(printf("v = %d\n", v));            // ← unit flows into a variadic slot
```

## Verbatim error

```
tmp/min_repro.c:6943:22: error: expected expression
 6943 |   printf("v = %d\n", );
 1 error generated.
yo: error: compile: C compiler failed (exit 1) on tmp/min_repro.c
```

## Root cause

Two independent facts, one hole:

1. **A block tail followed by `;` yields `unit` by design** (Rust-style), so
   the `io.async` closure above is `Future(unit)` — verified by probe:
   `cond(...)` as the whole body (no block, no `;`) types `i32`; the same
   expression inside `{ ...; cond(...); }` types `unit`. NOT a bug; the
   `return(...)` idiom used across the test suite is the explicit form.
2. **Variadic arguments were forwarded with no type validation**
   (`src/evaluator/calls/helper.yo`, Step 7b): every arg past the fixed
   parameters is evaluated and pushed as a runtime arg regardless of type.
   A `unit` expression in an argument slot has no C representation, and
   codegen emits NOTHING for it — the call reached the C compile as
   `printf("v = %d\n", )`, a hard error at the C stage. Nothing at `yo
   check` time stood in the way, including through `unsafe(...)`.

## Fix

Step 7b now rejects a `unit`-typed variadic argument for EXTERN callees
(`callee_is_extern`) at evaluation time:

```
error: A unit value cannot be passed as a variadic argument (a block tail
followed by ";" yields unit — end the block with the value, or return(...))
```

Yo-level quote/comptime variadics (`array_list(...)`, `hash_map(...)`) are
deliberately exempt — they build Yo values, where a unit element is legal.

Regression oracle: `tests/extern_unsafe_wrap.test.yo`'s
`comptime_expect_error(bad_variadic_unit ...)`, which fails on the v0.2.45
seed ("Expected compile error, but the expression was evaluated
successfully") and passes with the check in place. The identifier form
(`v := io.await(unit_future); printf("%d", v)`) errors at `yo check` with
the same message — the def-time body trial binds the future's `T` concretely,
so `v`'s unit is visible to the check.

## Disposition notes

- The originally suspected "cond tail drops the awaited value" reading was a
  red herring: the future is `Future(unit)` BY the `;` rule and codegen
  faithfully emitted nothing for the unit — the hole was the unchecked
  variadic slot, not async value plumbing.
- `never`-typed variadic args are not covered by the new check (a diverging
  expression carries control flow and does not reach the slot in practice);
  `unit` is the demonstrated and reachable case.
