> **RETIRED (2026-08-06) — diagnosis INVALID.** The accused codegen path
> (unit-comptime early return in `other-fn-call.ts`) never fires for this shape and
> cannot leak arg temps even in principle (elision happens before argument temps are
> materialized). The observed leak came from the reproducer's function being named
> `consume`: the BUILTIN `consume` silently shadows the user definition in both
> compilers' dispatch, and builtin-consume semantics legally suppress the drop.
> Renaming the function yields fully correct C. The real finding is filed as
> `issues/builtin-name-shadows-user-definition.md`.

# A fully CTFE-elided call leaves its owned RC argument temp undropped

**Found 2026-08-05** while fixing
`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md`. **Pre-existing, not a
regression** — the same allocation was undropped before that fix too; the fix only makes
it visible by giving the allocation a named C temp instead of emitting it as a bare
statement.

## Minimal reproducer

```rust
{ assert } :: import("std/assert");
MyVal   :: ref(enum(UnitVal, IntVal(v : i32)));
// Body is the unit literal, so the whole call is elided at compile time.
consume :: (fn(x : MyVal) -> unit)(());
main    :: (fn() -> unit)({
  consume(MyVal.UnitVal);
  assert(true, "ignored");
});
export(main);
```

Emitted `__yo_user_main` (current build):

```c
void __yo_user_main() {
  __yo_enum_…_id_3* _temp_40531 = __yo_new___yo_enum_…_id_3_UnitVal();   // rc 1
  __yo_effect_escaped = 0;
  fn_…_assert_…((bool)(true), (__yo_str){ … });
  if (__yo_effect_escaped) { return; }
}                                          // no ___drop of _temp_40531
```

There is no `fn_…_consume(…)` call at all — the callee was elided — and no drop.
Pre-fix the same program emitted a bare `__yo_new___yo_enum_…_UnitVal();` statement, also
undropped.

## Scope: narrower than it first appears

A unit-returning callee is **not** the trigger by itself. Both of these drop correctly:

```rust
noisy :: (fn(x : MyVal) -> unit)({ assert(true, "inner"); });   // unit return, real body
peek  :: (fn(x : MyVal, n : i32) -> i32)(n);                    // value return
```

Only a body the evaluator can fold away entirely (here the unit literal `()`) loses the
drop. `src/codegen/exprs/other-fn-call.ts:429-443` takes the `$.value`-first shortcut and
returns `""` for a unit type before any per-call drop anchor is emitted, so the argument
temp never appears in the call's `deferredDropExpressions`.

## Detection caveat

macOS `leaks --atExit` reports **0** for this program at `-O2`: nothing reads
`_temp_40531`, so LLVM deletes the allocation outright. The leak is real in the emitted C
and would be reported by LeakSanitizer on Linux if the value were observed. **Read the
emitted C — do not gate this family on `leaks` alone.**

## Where to look

The temp is a real env `Variable` registered at the enclosing begin-block frame, so the
fix is probably to let the elided-call path still contribute the argument's drop to the
enclosing scope rather than returning early — see `src/codegen/exprs/other-fn-call.ts`
`:433-441`, and the drop-collection in `src/codegen/exprs/begin.ts` for how a statement
position flushes pending drops.
