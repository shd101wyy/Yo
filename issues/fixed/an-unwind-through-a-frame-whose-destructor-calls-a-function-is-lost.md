# An unwind through a frame whose destructor makes a call is lost

**Severity:** S1: an effect `unwind` that passes through a frame dropping a `Box`, or any value whose `Drop` makes a call, is silently cancelled. The frame returns its zeroed dummy result as if it had returned normally, so the program computes with a wrong value or crashes (SIGSEGV on a `ref` result).

**Found:** 2026-10-17, converting `Pattern` to a value enum with `Box` children (VBD V4, `feat/vbd-v4-pattern-box`). The converted compiler crashed (SIGSEGV in `_bridge_expr_info`) while checking `tests/move_only.test.yo`: `_augment_arm_pattern` throws E0901 from inside the `.At(…, Box(sub))` arm, and the escape path drops the arm's `new_sub` pattern, whose `Box` drop cleared the throw. Reproduces on the v0.2.64 seed with user code.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
ErrNode :: ref(enum(Leaf(name : String), Pair(a : String, b : String)));
Raise :: (ctl(msg : &String) -> ErrNode);
middle :: (fn(n : i32, raise : Raise) -> ErrNode)({
  held := box(n);
  r := cond(
    (n == i32(0)) => raise(String.from("boom")),
    true => ErrNode.Pair(a : String.from("l"), b : String.from("r"))
  );
  r
});
outer :: (fn(n : i32) -> ErrNode)({
  (raise : Raise) = (msg -> unwind(ErrNode.Leaf(name : String.from("caught"))));
  middle(n, raise)
});
main :: (fn() -> unit)({
  r := outer(i32(0));
  match(r, .Leaf(name) => println(&name), .Pair(a, b) => println(&a));
});
export(main);
```

Expected `caught`; got exit 139. With `held := n` it prints `caught`. A value struct or a `ref(struct)` whose `Drop` calls a function (`g = count(g)`) in place of the `Box` fails the same way.

## Cause

The escape path of a frame (`emit_effect_unwind_check`'s propagation branch, and `generate_unwind` after it raises the flag; `src/codegen/exprs/return.yo`) drops the frame's locals and then returns a dummy, relying on `__yo_effect_escaped` still being 1 for the caller's check. A drop that runs a destructor runs ordinary generated code, and every may-unwind call in it (any direct call through an atom, `_call_may_unwind`) is emitted as `__yo_effect_escaped = 0; <call>; if (__yo_effect_escaped) …`. `Box.drop` calls `_box_owner_of`, so dropping a `Box` on the escape path reset the flag to 0. The frame returned `(T){0}` with the flag down, and its caller used the dummy as the result.

`Pattern` as a `ref(enum)` did not hit this: its synthesized dispose only decrements counts and makes no Yo calls.

## Fix

`_reraise_escape_after_drops` (`src/codegen/exprs/return.yo`) raises `__yo_effect_escaped` again after an escape sequence's drops whenever any drop was emitted: in the propagation branch of `emit_effect_unwind_check` (sync and async, not at a handler installation, which clears the flag anyway) and after `generate_unwind`'s drops. An escape path with no drops emits exactly what it did before.

## Test

`tests/algebraic_effects.test.yo`, "an unwind passes through a frame whose destructors make calls": a `Box` local, a value struct with a calling `Drop`, and a `ref(struct)` with a calling `Drop`, each in a frame an unwind passes through. It fails on the v0.2.64 seed (exit 6, the unwound `-7` comes back as `0`) and passes with the fix.
