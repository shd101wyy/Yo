# A free-function call accepts an already-moved argument; the second call reads freed memory

**Status: FIXED 2026-09-25** (Phase 2.5 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: memory safety.** An `own(...)` parameter consumes its argument, and using the variable
again is E0901 "use of moved value". The method-call path enforced that. The free-function path
did not:

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
_eat :: (fn(own(s) : String) -> usize)(s.len());
main :: (fn() -> unit)({
  a := String.from("abc");
  n1 := _eat(a);
  n2 := _eat(a);     // accepted; `a` was moved by the first call
  println(n1 + n2);  // printed 3, not 6: the second call read a released String
});
export(main);
```

The same shape through a method (`h.eat(a); h.eat(a)`) was rejected at the second call. The
v0.2.41 seed accepts the free-function program.

**Found** 2026-09-25, probing the differences between the parameter-binding sites that Phase 2.5
unifies.

## Root cause

The two call paths each carried a copy of the argument/parameter rule. The `try_to_call` path
(`check_if_function_parameter_matches_argument`) had Step 4a:
`require_expr_not_consumed`, unconditional. The inline FuncVal arm of `calls/function.yo`, which
every call to a module-level function takes, copied Steps 4b and 4c but not 4a.

## Fix

The rule is one helper, `consume_argument_for_parameter` (`calls/helper.yo`: Steps 4a, 4b, 4c),
called from both paths. The arm's copy also used `is_type_hierarchy_type` where the other used
the declared `comptime` flag, and it lacked the checking-phase gate on the move. Both now follow
the one rule.

## Verification

`tests/type_soundness.test.yo`, "a moved argument is rejected on both call paths".
