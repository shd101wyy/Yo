# A Dyn listing two marker traits emits a duplicate vtable member

**Severity:** S2: a valid `Dyn(Fn() -> unit, Send, Sync)` (or any `Dyn` whose traits declare the same non-function member, such as the marker traits' `id`) passes `yo check` and then fails in the C compiler with `error: duplicate member '__yo_v_id'`. That `Dyn` is what `Arc(Dyn(Fn() -> unit, Send, Sync))`, the thread-shared form of a uniquely owned `Dyn` (plans/VALUES_BY_DEFAULT.md decision 7), needs.

**Status:** FIXED 2026-10-24 (`feat/b12-dyn-gen-a`). **Found:** 2026-10-24, while sweeping `tests/parallelism_soundness.test.yo`'s shared `Dyn(Fn, Send)` canary onto `Arc` for B12. Develop `f1cfa553d` fails the same way.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (k : Impl(Fn() -> unit)) = (() => println(1));
  (d : Dyn(Fn() -> unit, Send, Sync)) = dyn(k);
  d();
});
export(main);
```

```text
tmp/p5.c:985:12: error: duplicate member '__yo_v_id'
  985 |   __yo_str __yo_v_id; // Non-function member id
```

## Root cause

`generate_dyn_declaration` (`src/codegen/types/generation.yo`) collects one member line per trait member through `_dyn_vtable_method_line`. That helper records a member's label in `processed` so that a second trait naming it adds no second line, but it recorded only function members. `Send` and `Sync` each declare the non-function member `id := "..."`, so both added a `__yo_v_id` member to the vtable struct.

## Fix

`_dyn_vtable_method_line` records a non-function member's label too, so the first trait to name it gives the vtable its one member. Nothing initializes or reads such a member (`generate_dyn_vtables` and the dispatch only fill method slots), so which trait contributes it does not matter.

## Verification

`tests/dyn.test.yo` ("a Dyn listing Send and Sync compiles one member per name") calls a `Dyn(Fn() -> unit, Send, Sync)` and shares one through an `Arc`. `tests/parallelism_soundness.test.yo`'s canary shares a `Dyn(Fn() -> unit, Send, Sync)` across two threads through `Arc`. Both fail to compile before the fix and pass after it.
