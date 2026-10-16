# A closure returned from a function retains its captures twice

**Severity:** S2 — every call of a function whose tail or `return` value is a closure literal capturing a reference-counted value leaked that value once; a factory called in a loop grew without bound.

**Found:** 2026-10-16, while sorting the leak verdicts of `tests/async_generic_future_return.test.yo` ("a generic Impl(Fn(...) -> Result(T, E)) closure ending in a bare-variant match", 24 bytes). Nothing async is involved, and nothing generic: it reproduces on develop `b0c4630d3`, `0684c9c40` and seed v0.2.63.

## Reproducer

```yo
mk :: (fn() -> Impl(Fn() -> i32))({
  b := Rc(i32)(i32(1));
  () => b.*
});
main :: (fn() -> unit)({
  f := mk();
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r`: `SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s).`

## Root cause

```c
__yo_t_closure tmp = (__yo_t_closure){ .__yo_v_b = __yo_incr_rc(__yo_v_b) };  // the capture's reference
__yo_incr_rc(__yo_v_b);                                                     // emitted again
__yo_decr_rc(__yo_v_b);                                                     // b's scope end
return tmp;
```

A closure construction's deferred dups are its captures' own references, and the closure emitter writes them into the capture struct's initializer (`closures.yo`). The function-tail path (`src/codegen/functions/generation.yo`) treated any tail with deferred dups as a BORROWED value that needs a +1 before it leaves, and emitted the same dups again. `emit_deferred_dup_or_code` already knew the rule (its `src_is_closure_ctor` guard); `generate_deferred_dup_expressions` and the tail path did not.

## Fix

`is_closure_construction` (`src/codegen/exprs/drop_dup.yo`) names the rule once. `generate_deferred_dup_expressions` emits nothing for a closure construction, which covers every site that emits a value's dups through it (a `return`, an arm value, an argument), the tail path does not treat a closure construction as a borrowed tail, and `emit_deferred_dup_or_code` uses the same predicate.

Test: `tests/closure.test.yo`, "a closure literal returned from a function releases its capture once" (a `Drop` counter on the capture, through a tail and through a `return`). It fails on develop `b0c4630d3`.
