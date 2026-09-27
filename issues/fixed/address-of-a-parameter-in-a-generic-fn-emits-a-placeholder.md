# `&param` inside a GENERIC function emits `/* skip generating value */`

**Status:** FIXED 2026-09-27 (branch `tss/dyn-upcast`; see Resolution)
**Found:** 2026-09-08, implementing `black_box` for `plans/archive/STD_API_STABILIZATION.md` §4 Core.

## Reproducer (8 lines)

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
_t :: (fn(generic(T : Type), v : T) -> T)({
  (p : *(T)) = &v;
  unsafe(p.*)
});
main :: (fn() -> unit)({
  println(`t=${_t(u64(6))}`);
});
export(main);
```

`yo check` passes. The emitted C does not compile:

```
/tmp/amp5.c:2110:44: error: expected expression
 2110 |   uint64_t* p = /* skip generating value */;
      |                                            ^
```

The address-of expression is not generated at all — codegen leaves the comment
it uses for values it has decided to skip.

## Isolation

| shape | result |
| --- | --- |
| `&local` in a CONCRETE fn | OK |
| `&param` in a CONCRETE fn | OK |
| `&local` (a copy of a param) in a GENERIC fn | OK |
| **`&param` in a GENERIC fn** | **placeholder → C error** |

So it is specific to a parameter of a function carrying `generic(...)`, and it
does not matter whether the parameter is also used by value: the two-line body
above has no other use of `v`.

## Workaround, and why it is acceptable HERE

Copy the parameter into a local first:

```rust
(local : T) = v;
(p : *(T)) = &local;
```

`std/testing/bench.yo`'s `black_box` does exactly this, with a comment pointing
here. For that function the copy is genuinely free of consequence — the value
arrives by value anyway — but that is a property of `black_box`, not a general
answer: anything that needs the address of the CALLER's storage (an in-place
mutation through a generic `inout`-style parameter) has no such escape.

## Guess at the cause

A generic function's body is evaluated against a call-time binding rather than
the def-time env (`should_defer_ft`), and the parameter's `Variable` on that
path is missing whatever the address-of emitter reads to name its storage — the
same family as the `own`-parameter flags that
`issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md` traced to the
two call-time binders hardcoding a flag the def-time binder sets. Worth
checking the three parameter-binding sites named in AGENTS.md before anything
in codegen.

## Resolution (2026-09-27)

**Cause (measured with v0.2.44):** the argument's *value*, not the generic. `_t(u64(6))` fails,
`_t(x)` with a runtime `x` emits `(&v)`. A specialization binds each parameter with the call's
argument value (`bind_parameter`, `src/env.yo`), so a CTFE execution of the body can read it; a
runtime parameter's `Variable` therefore holds `6` in its value cell. `evaluate_address_call`
(`src/evaluator/builtins/ptr_fns.yo`) turns `&x` of any variable with a non-empty cell into a
compile-time place (`PtrVal`), which is right for a comptime local and wrong for a C parameter:
codegen could not render the comptime pointer and wrote its placeholder.

**Fix:** the place arm skips a runtime parameter (`is_parameter && !is_compile_time_only`)
unless the evaluation is executing (CTFE). Test: `tests/ptr.test.yo`, "&param in a generic fn
called with a literal". `std/testing/bench.yo`'s `black_box` keeps its local copy until the seed
carries this fix (std compiles with the seed).
