# An unwind is lost when a temporary dropped after the call runs a destructor that calls a function

**Severity:** S1 — an `unwind` through a call is silently dropped: the calling frame continues with the call's dummy result (`false`, `0`, a null reference) and executes code that must not run, so a program computes wrong results or dereferences null with no diagnostic.

## Reproducer

`issues/repros/2026-10-22-an-unwind-is-lost-when-a-temporary-dropped-after-the-call-runs-a-destructor-that-calls-a-function.yo`:

```yo
{ println } :: import("std/fmt");
Raise :: (ctl(code : i32) -> bool);
mut(HELPER_CALLS) := i32(0);
helper :: (fn(n : i32) -> unit)({
  HELPER_CALLS = (HELPER_CALLS + n);
});
Noisy :: struct(n : i32);
impl(
  Noisy,
  Drop(
    drop : (fn(self : &mut Self) -> unit)(helper(self.n))
  )
);
make_noisy :: (fn(n : i32) -> Noisy)(Noisy(n : n));
fails :: (fn(x : &Noisy, raise : Raise) -> bool)(raise(x.n));
middle :: (fn(raise : Raise) -> i32)({
  mut(r) := i32(0);
  if(fails(&make_noisy(i32(1)), raise), {
    r = i32(1);
  });
  println("BUG: middle continued after the handler unwound");
  r
});
run :: (fn() -> i32)({
  (raise : Raise) = (
    code -> {
      unwind(i32(-1));
    }
  );
  middle(raise)
});
main :: (fn() -> unit)({
  a := run();
  println(&a);
  calls := HELPER_CALLS;
  println(&calls);
});
export(main);
```

Expected: `-1`, then `1`. The v0.2.67 seed and the tree at `c8d297cc1` print `BUG: middle continued after the handler unwound`, then `0`, then `1`.

Found 2026-10-22 when `std/collections/array_list.yo` started destroying its elements through `drop_in_place(p)`, a function call: the compiler built from that tree lost unwinds inside its own parser, so `yo fmt --check src/evaluator/context.yo` crashed with a null `AstExpr` (SIGSEGV), and `tests/async_await.test.yo` and `tests/deref_auto.test.yo` lost expected diagnostics.

## Root cause

A call that may unwind is emitted as `__yo_effect_escaped = 0; <call>; <deferred drops>; if (__yo_effect_escaped) { ... }`. The deferred drops release the call's temporaries (here the `Noisy` lent with `&make_noisy(...)`) before the unwind check. A destructor is ordinary code: every call in it that may unwind starts with `__yo_effect_escaped = 0;`, so a destructor that calls a function (here `helper`) cleared the flag the handler had just raised, and the check after the drops saw no unwind.

`issues/fixed/an-unwind-through-a-frame-whose-destructor-calls-a-function-is-lost.md` fixed the same clearing for the drops ON the escape path (`_reraise_escape_after_drops`); the drops between the call and its check were not covered.

## Fix

`generate_call_deferred_drops` (`src/codegen/exprs/return.yo`) emits a call's deferred drops and, when the call may unwind and drops were emitted, saves the flag before them and restores it after:

```c
__yo_effect_escaped = 0;
bool t = fails(tmp, raise);
int __yo_escaped_keep_0 = __yo_effect_escaped;
/* drop tmp: its destructor clears the flag */
__yo_effect_escaped = __yo_escaped_keep_0;
if (__yo_effect_escaped) { ... }
```

Every drop-then-check site in `src/codegen/exprs/other_fn_call.yo` (ten) and `src/codegen/exprs/recur.yo` (three) goes through it.

## Test

`tests/algebraic_effects.test.yo`, "an unwind passes a call whose temporary argument's destructor makes a call": a temporary `_EscGuard` (whose `Drop` makes a call) and a temporary `Box(i32)` (whose `Drop` calls `drop_in_place` and `_box_owner_of`) are lent to a call whose handler unwinds. Before the fix both frames continue and return `1` instead of the unwound `-7`/`-8`.

## Seed gate

The compiler is compiled by the seed, so its own code keeps the bug until `SEED_VERSION` carries this fix. A destructor in `std/` that the compiler runs must not start making calls before then: moving `std/collections/array_list.yo`'s element destruction to `drop_in_place` made the seed-built compiler lose unwinds in its parser. That move is parked in `plans/backlog/SEED_VERSION_AUTOMATION.md` ("`drop_in_place` at std's raw-slot sites").
