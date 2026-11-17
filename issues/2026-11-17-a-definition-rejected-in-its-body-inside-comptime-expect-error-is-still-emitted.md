# A function definition rejected in its body inside `comptime_expect_error` is still emitted, and after the `str` flip its C does not compile

**Severity:** S2. A test file holding such a negative row fails to compile in C, so none of its tests run.
`tests/dyn.test.yo` is red on develop `916b279c1` (#1980, the `str` flip). No program outside
`comptime_expect_error` is affected: there, the first rejection stops compilation.

**Status:** OPEN. Found 2026-11-17 by the S3b-`Dyn` lane while re-gating on develop `916b279c1`. A develop-built
binary (`yo build` of `916b279c1` with the v0.2.78 seed) gives the same error, so the S3b-`Dyn` branch did not cause it.

## Reproducer

The row in `tests/dyn.test.yo` ("a Dyn copy out of storage that cannot give it away is E0901 at once"):

```yo
{ String } :: import("std/string");
_UdCounter :: trait(
  bump : (fn(self : &mut Self) -> unit),
  count : (fn(self : &Self) -> i32)
);
_UdTally :: struct(n : i32, label : String);
derive(_UdTally, Clone);
impl(
  _UdTally,
  _UdCounter(
    bump : (fn(self : &mut Self) -> unit)({
      self.n = (self.n + i32(1));
    }),
    count : (fn(self : &Self) -> i32)(self.n + i32(self.label.len()))
  )
);
main :: (fn() -> unit)({
  comptime_expect_error((fn(d : &Dyn(_UdCounter, Clone)) -> Box(Dyn(_UdCounter, Clone)))(d.*), "it is a `&T` parameter");
});
export(main);
```

`yo check` is clean (the expected E0901 is raised). `yo compile` fails in C:

```text
error: indirection requires pointer operand ('__yo_t_…' invalid)
  return (*__yo_v_d);
```

## Root cause

There are two parts.

1. **The rejected definition is still emitted. This is pre-existing.** The function literal is registered before its
   body is evaluated. The body's `d.*` then throws E0901 (`_throw_explicit_copy_violation`,
   `src/evaluator/utils.yo`). Nothing on that path calls `mark_fn_unemittable`, which the result-type checks in
   `src/evaluator/calls/function_type.yo` and the capture check in `anonymous_function.yo` call before they throw.
   Codegen therefore emits the body of a function with no callers. Before #1980 the body was `return __yo_v_d;`,
   which compiled by accident. The binary built from `8311fbc19` (develop plus the deref flip) emits exactly that.
2. **#1980 changed the body's C.** `_var_read_code` (`src/codegen/exprs/atom.yo`) now reads a borrow binding as
   `(*name)` when the read's type is unsized (`read_unsized && t_slot_is_borrow`). `d.*` with `d : &Dyn(...)` is such
   a read. A `&Dyn` is the fat pair by value at the C level, so `(*d)` is not C. The convention is sound in a valid
   program, where every unsized place is lent and folds back. Only a by-value read of a `Dyn` place produces it, and
   only a rejected program contains one.

## Fix direction

Mark the definition unemittable whenever its body evaluation throws, not at each throw site. Two ways to do that: the
function-literal evaluation records the `fn_val_id` it registered and marks it when the body throws, or
`comptime_expect_error` marks every function registered after its mark when its argument throws, the way it already
rolls back `dyn_copy` and `unsized_sites`. The test is the existing `tests/dyn.test.yo` row. It fails on `916b279c1`
and passes with the fix.
