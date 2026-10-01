# A module-level `unit`-typed global emits a `void` C variable

**Severity:** S2 — a valid program fails at the C compiler: a module-level runtime binding of type `unit` is emitted as a `void` variable with an empty initializer.

**Status: OPEN.** Found 2026-10-01 on develop `6f5dec5db`, writing a scratch instrument that ran an initializer for its side effect at module load.

## Repro

```rust
{ println } :: import("std/fmt");
init :: (fn() -> unit)(println("init"));
(_g : unit) = init();
main :: (fn() -> unit)({
  println("main");
});
export(main);
```

```
$ yo compile unitg.yo -o unitg
unitg.c:986:13: error: variable has incomplete type 'void'
unitg.c:2535:29: error: expected expression
yo: error: compile: C compiler failed (exit 1) on unitg.c
```

The emitted C is `static void _g_m…; // module-level mutable variable`, and in the module initializer `_g_m… = ;`.

## Expected

A `unit` global has no storage. The initializer should run for its effect, with no variable declared and no assignment emitted, as a `unit` local is handled. Alternatively the evaluator could reject a `unit`-typed module-level runtime binding with a diagnostic.

## Fix

A test in `tests/` with a module-level `unit` binding whose initializer prints, which fails before the fix.
