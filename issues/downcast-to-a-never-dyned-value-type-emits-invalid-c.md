# `downcast(dyn, T)` to a value type that is never `dyn()`-wrapped emits invalid C

**Status:** OPEN
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit —
the row asks for an `is(T)` helper on `AnyError`, and the first negative test
written for it (is this error some OTHER type?) failed to compile.
**Severity:** crash class. `yo check` is green; the C compiler rejects the
emitted file, so the whole build dies with an internal `__yo_tN` type name as
the only diagnostic.

## Symptom

The NEGATIVE downcast — asking whether an `AnyError` holds a value type that
this program never puts into a `Dyn` — does not compile.

```rust
{ AnyError, Error } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

MathError :: enum(DivZero, Overflow);
impl(MathError, ToString(to_string : (fn(inout(self) : Self) -> String)(`math error`)));
impl(MathError, Error());

is_string :: (fn(err : AnyError) -> bool)(
  match(downcast(err, String), .Some(_) => true, .None => false)
);

main :: (fn(io : Io) -> unit)({
  (e : AnyError) = dyn(MathError.DivZero);
  match(is_string(e), true => println(`yes`), false => println(`no`));
});
export(main);
```

`yo check` passes. `yo compile … --optimize 2`:

```
d1.out.c:2088:167: error: used type '__yo_t4' (aka 'struct __yo_t5_struct') where arithmetic or pointer type is required
 2088 |   __yo_t14 _file____priv_temp_9307 = ((err.vtable->__yo_type_id == (uintptr_t)&__yo_typeid___yo_t4) ? (__yo_t14){ .tag = __YO_T14_SOME, .data = { .Some = { .value = ((__yo_t4)__yo_incr_rc((void*)err.data)) } } } : (__yo_t14){ .tag = __YO_T14_NONE });
1 error generated.
yo: error: compile: C compiler failed (exit 1) on d1.out.c
```

Expected: it compiles and prints `no` — the answer is statically knowable, since
nothing in the program ever boxed a `String` into a `Dyn`.

The same failure appears for a value ENUM target, which is the shape a real
error handler uses:

```rust
OtherError :: enum(Boom(code : i32));
impl(OtherError, ToString(to_string : (fn(inout(self) : Self) -> String)(`other`)));
impl(OtherError, Error());
…
match(downcast(e, OtherError), .Some(_) => println(`other`), .None => println(`not other`));
```

```
d1b.out.c:1655:166: error: used type '__yo_t13' (aka 'struct __yo_t13_struct') where arithmetic or pointer type is required
```

Only the target matters, not the `Dyn`: `String` and `OtherError` are perfectly
legal `Error` implementors, they are simply not `dyn()`-wrapped anywhere in
*this* program.

## Root cause

`generate_downcast` (`src/codegen/exprs/downcast.yo:66`) picks the extraction by
target shape:

- a REFERENCE struct target is the object pointer itself — cast + `__yo_incr_rc`;
- a VALUE/newtype target was auto-boxed at `dyn()` creation, so the value must be
  read out of the box: `((Box*)dyn.data)->field` + `___dup`.

To find the box's C type it scans `context.base.dyn_impls` for an entry whose
`(dyn_type, concrete_type)` pair matches this downcast
(`src/codegen/exprs/downcast.yo:74-97`). That registry is populated from the
`dyn()` CREATION sites the collector walks
(`src/codegen/functions/collection.yo:903`, via `register_dyn_impl`,
`src/codegen/utils/index.yo:494`) — so it holds an entry only for a type that is
actually wrapped somewhere in the program.

When the scan finds nothing the emitter falls back to the OBJECT cast
(`src/codegen/exprs/downcast.yo:122-130`):

```rust
.None => {
  // No box found — fall back to the object cast (keeps prior behaviour).
  o := String.from("((");
  o.push_string(target_type_c_name.clone());
  o.push_str(")__yo_incr_rc((void*)");
  …
```

`target_type_c_name` for a value target is a struct type, and C cannot cast a
`void*` to a struct — hence `used type '__yo_t4' … where arithmetic or pointer
type is required`. This is the fallback branch that
`issues/fixed/yo-self-downcast-value-type.md` left in place when it added the
box-extraction path; the box path fixed the case where the target IS dyn'd
somewhere, and this is the complementary case.

Note the `.None` case is not merely un-emittable — it is *statically decidable*.
The runtime check is `dyn.vtable->__yo_type_id == &__yo_typeid_<T>`, and that
static's address only ever lands in a vtable built from a `dyn_impls` entry. With
no entry for `T`, the comparison can never be true, so the whole expression is
`Option(T).None`.

## Why no test caught it

Every downcast target in `tests/dyn.test.yo` (`:147`, `:165`, `:183-184`,
`:196-212`) is a `ref(struct(...))`, which takes the object-cast path and never
consults the box scan. Every value-typed target in `tests/error.test.yo`
(`String` at `:9,:17,:42,:114`, `MathError` at `:84,:156`) is also a `dyn()`
creation site in the same test, so the scan always hits. The uncovered
combination is exactly "value target, not dyn'd here".

## Fix

In `src/codegen/exprs/downcast.yo`, replace the `.None` object-cast fallback
with a statically-`.None` result. The dyn operand must still be evaluated (it can
be an arbitrary expression, including a call), so emit the operand for effect and
discard it — e.g. a comma expression `((void)(<dyn_code>), (Option){ .tag =
<none_tag> })` for the tagged-union form, and `((void)(<dyn_code>), NULL)` for
the nullable-pointer-optimized form (`can_optimize_as_nullable_pointer`,
`src/codegen/exprs/downcast.yo:139`). Do not skip the `__yo_typeid_<T>` static
registration (it is harmless) and do not synthesize a box type for `T`: no
`__yo_dyn_box_<T>` typedef is emitted for a concrete that has no `dyn_impls`
entry (`generate_dyn_box_types`, `src/codegen/types/generation.yo:1135-1138`, walks the same registry), so naming one would
trade this error for an undeclared-type error.

Reject the alternative of making the evaluator reject the downcast: a downcast
that cannot match is a legitimate, useful question — it is exactly what an
`is(T)` / error-classification helper asks — and rejecting it would make such a
helper's callers depend on which types happen to be dyn'd elsewhere in the
program.

## Regression test

`tests/dyn.test.yo`, next to "Test downcast failure" (`:158`): a test that
`dyn()`s one value type and downcasts to a DIFFERENT value type that the test
file never wraps, asserting `.is_none()`. Verify it is RED first (today it fails
the C compile, taking the whole batch with it). Add the mirror case to
`tests/error.test.yo`: `downcast(err, SomeNeverThrownError)` on an `AnyError`
built from ``dyn(`…`)``, asserting the `.None` arm runs.

## Not a breaking change

Programs that compile today keep compiling; this only turns a hard C error into
a correct, statically-false result.
