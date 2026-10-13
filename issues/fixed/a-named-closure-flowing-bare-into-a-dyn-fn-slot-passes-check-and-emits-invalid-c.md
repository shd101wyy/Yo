# A named closure flowing bare into a `Dyn(Fn(...))` slot passes `check` and emits invalid C

**Severity:** S2 — a program `yo check` accepts fails at the C compiler with three type errors; the same program with `dyn(f)` at each site compiles and runs

**Status: FIXED** 2026-10-13 (found 2026-10-12 with v0.2.59 while amending `plans/VALUES_BY_DEFAULT.md` decision 44).

## Symptom

A closure **literal** in a `Dyn(Fn(...))` slot is rejected at check time
(`Anonymous function: expected a Func or Impl(Fn(...)) type`), and
`docs/en-US/DESIGN.md` ("Closure types") says to write `dyn(...)` around a
closure to make a `Dyn(Fn(...))`. A **named** `Impl(Fn(...))` value is
different: the evaluator lets it flow bare into a `Dyn(Fn(...))` binding,
struct field, by-value argument and function result, and `yo check` is
green. Only the binding site is lowered; the other three copy the closure's
capture struct into the fat-pointer slot and clang rejects the C.

```yo
{ assert } :: import("std/assert");
_hold :: ref(struct(f : Dyn(Fn() -> i32)));
_take :: (fn(sink(d) : Dyn(Fn() -> i32)) -> i32)(d());
_ret :: (fn() -> Dyn(Fn() -> i32))({
  (g : Impl(Fn() -> i32)) = (() => i32(9));
  g
});
main :: (fn() -> unit)({
  n := i32(3);
  (f : Impl(Fn() -> i32)) = (() => n);
  (d : Dyn(Fn() -> i32)) = f;
  h := _hold(f : f);
  r := _take(f);
  q := _ret();
  (s : i32) = (((d() + h.f()) + r) + q());
  assert(s == i32(23), "sum");
});
export(main);
```

```
$ yo check ./tmp/fixme.yo --std-path ./std      # green (an unused-variable warning only)
$ yo compile tmp/fixme.yo --std-path ./std --optimize 0 -o tmp/a.out
tmp/a.out.c:2649:111: error: passing '__yo_t_9019624315123366382' (aka 'struct __yo_t_9019624315123366382_struct') to parameter of incompatible type '__yo_t_11831253704766666267'
 2649 |   __yo_t_16114296894961032705* _file____User_temp_14379832152965047320 = __yo_new___yo_t_16114296894961032705(__yo_v_f);
tmp/a.out.c:2652:86: error: used type '__yo_t_11831253704766666267' where arithmetic or pointer type is required
 2652 |   int32_t _file____User_temp_42514399179431226610 = yo_id_12513981056069203085000000((__yo_t_11831253704766666267)(__yo_v_f));
tmp/a.out.c:2701:10: error: returning '__yo_t_5238406131168382789' (aka 'struct __yo_t_5238406131168382789_struct') from a function with incompatible result type '__yo_t_11831253704766666267'
 2701 |   return __yo_v_g;
3 errors generated.
yo: error: compile: C compiler failed (exit 1) on tmp/a.out.c
```

The three errors are the field initializer (`_hold(f : f)`), the argument
(`_take(f)`) and the result (`g`). The binding `(d : Dyn(...)) = f` alone
compiles and runs (`assert(d() == i32(3))` passes).

With `dyn(f1)`, `dyn(f2)`, `dyn(f3)` and `dyn(g)` at the four sites (one
closure per site, since `dyn` moves its argument) the program compiles and
`./tmp/b.out` exits 0.

## Root cause

Type compatibility accepts an `Impl(Fn(...))` value for a `Dyn(Fn(...))`
slot without recording a conversion on the expression, so codegen has
nothing to lower except at the typed-binding site, where the binding path
synthesizes the box itself. The field, argument and result paths emit the
value as it is: a capture struct where the C expects the `{data, vtable}`
pair.

## Decision

Decided with `plans/VALUES_BY_DEFAULT.md` decision 44 (2026-10-12): the
erasure is always spelled. A bare `Impl(Fn(...))` value or named `fn` in a
`Dyn(Fn(...))` slot is a **type error** at every site, with a note naming
`dyn(f)`; the binding site stops accepting the bare form too, so the four
sites agree. No codegen change: the rejection is the fix.

## Test

In `tests/closure.test.yo`: `comptime_expect_error` on the bare `f` at a
`Dyn(Fn(...))` binding, field initializer, by-value argument and result
(each naming `dyn(f)`), the same for a named `fn`, and the reproducer's
`dyn(...)` version as a passing case summing to 18 (see the end). The bare cases
fail today (no error is raised), and the `dyn` case passes before and
after.

## Fix

E0618 ("a callable flows bare into a `Dyn(Fn(...))` slot"), raised by
`reject_bare_callable_into_dyn_fn` (src/evaluator/utils.yo) before the
slot's compatibility and escape checks at every site the value can flow
through: a typed binding and a reassignment, a field write, a constructor
field and a variant payload, an argument (`check_argument_for_parameter`,
both call routes), a function, specialized or closure body tail, and
`return(f)`. A closure literal against a `Dyn(Fn(...))` expected type raises
it too. The predicate is `is_bare_callable_into_dyn_fn` (src/types/utils.yo).
The reproducer is now rejected at its first site:

```
error[E0618]: A callable flows bare into `d` of type `dyn(Fn() -> i32)`: `f` has type ...
help: write `dyn(f)`; `yo fix <path> --migrate dyn-spelling` wraps every such site
```

`yo fix <path> --migrate dyn-spelling` wraps every bare site
(cli-case `tests/cli-cases/fix-migrate-dyn-spelling`). No codegen change.
A bare named `fn` is rejected the same way, but `dyn(named_fn)` still emits
invalid C: `issues/dyn-of-a-named-function-value-emits-invalid-c.md`.

The reproducer's `assert(s == i32(23), ...)` is an arithmetic slip in this
report: the four calls return 3, 3, 3 and 9, so the sum is 18, and the
`dyn(...)` version in `tests/closure.test.yo` asserts 18 (with 23 it aborts
in the assert, which is how the slip was found).
