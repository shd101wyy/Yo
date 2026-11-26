# `Negate.Output` and `BitNot.Output` are ignored: an impl whose `Output` is not `Self` fails with an uncoded error raised inside the prelude

**Severity:** S2 — a valid `impl(V, Negate(Output : W, …))` (the trait declares `Output`, and `Add` and the other binary operators honour it) cannot be used: `-v` is rejected with an uncoded "Cannot unify incompatible struct types" located in `std/prelude.yo`.

**Status:** fixed by VERDICTS-87 PR D (`wip/v0281-v87d`): the runtime `(-)` and `(~)` dispatchers (`neg`, `bit_not`) return `_Self.Output`. The comptime twins keep `comptime(_Self)`, because `comptime(_Self.Output)` hits a separate evaluator bug, `issues/2026-11-26-a-generic-comptime-associated-type-return-is-left-unresolved.md`; every prelude comptime impl has `Output = Self`, so the runtime fix is the one this issue's program needs. The traits are `Neg` and `BitNot` since PR A. Test: `tests/prelude.test.yo`, "Neg and BitNot honour an Output that is not Self".

**Found:** 2026-11-26, VERDICTS-87, probe `u3`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `030d63040`.

## Symptom

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

V :: struct(x : i32);
W :: struct(y : i32);
derive(V, Copy, Clone);
impl(V, Negate(Output : W, neg : (fn(self : Self) -> Self.Output)(W(y : (i32(0) - self.x)))));
impl(V, BitNot(Output : W, (~) : (fn(self : Self) -> Self.Output)(W(y : ~self.x))));

main :: (fn() -> unit)({
  b := V(x : i32(3));
  n := -b;
  m := ~b;
  println(`${n.y} ${m.y}`);
});
export(main);
```

```text
error: Cannot unify incompatible struct types: "W" and "V"
    --> ./u3-neg-output-differs.yo:10:8
    |
 10 |   n := -b;
    |        ^

note: raised here, inside the standard library
    --> /home/yiyiwang/Workspace/Yo-wt/v87-file/std/prelude.yo:714:16
    |
714 |     return(self.neg());
    |                ^
yo: error: check: 1 file(s) failed evaluator coverage
```

The line is uncoded. VERDICTS-87 measured that with `-> _Self.Output` on the two dispatcher lines the same program compiles and runs.

## Root cause

The prelude's unary dispatchers `(-)` (`neg`, ~705) and `(~)` (`bit_not`, ~687) are declared `-> _Self` (and `-> comptime(_Self)` for the comptime twins), so the result must unify with the operand's type even though `Negate.Output` / `BitNot.Output` say otherwise. Every prelude impl has `Output = Self`, which hid it.

## Fix

VERDICTS-87 PR D (`plans/backlog/STD_RUST_ALIGNMENT.md` §9): the `(-)` and `(~)` dispatchers return `_Self.Output`, the comptime twins included.

## Test to add with the fix

In `tests/prelude.test.yo`: the program above as a test (a user type whose `Negate` and `BitNot` have `Output` different from `Self`), asserting `n.y == -3` and `m.y == -4`. Fails before the fix with the error above.
