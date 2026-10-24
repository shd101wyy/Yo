# Two async functions through one function-typed parameter are called through an incompatible pointer type

**Severity:** S2 — a function returning `Impl(Future(...))` stored in a `fn(...) -> Impl(Future(...))` slot (parameter, field, result, mutable local) is called through a function-pointer type it was not defined with: C undefined behavior that `--sanitize undefined` aborts on (Promise A), and the field-only shape is rejected by the C compiler; no wrong value observed (the two pointer types share an ABI and a common initial layout).

**Status:** open. Found 2026-10-24 by the scheduled UBSan workflow
(`ubsan.yml`, job `UBSan (language suite, Linux/Clang)`): run 40066504401 on
develop `c0cd51a30` and run 39006429120 on `4d7c15caa` (2026-10-17).

## Not a regression

The last green UBSan run (38027852680, `a411556e7`, 2026-10-10 04:31 UTC) ran
before the failing test existed. The test `two async functions through one
function-typed parameter` was added later that day by #1298 (`3d4474d08`,
`issues/fixed/a-function-returning-impl-passed-to-a-function-typed-parameter-is-called-through-void-pointer.md`).
That change exempted `Impl(Future(...))` from the "a bare fn type cannot
carry an opaque `Impl`" rule on the grounds that "every future lowers to one
pointer to a state machine". At run time that holds: the program prints 42
and 24, and ASan reports nothing. In the emitted C it does not hold: the two
pointers are different C types. So the bug has existed for as long as the
test has, and no bisect was needed.

## Reproduction

`yo test ./tests/async_future_parameter.test.yo` with
`YO_TEST_SANITIZE=undefined --c-compiler clang`, with the tree-built binary at develop
`27431e4be` and with the v0.2.69 seed alike:

```
✗ two async functions through one function-typed parameter
  …bin.c:9643:103: runtime error: call to function (unknown) through pointer to incorrect function type
  'struct __yo_t_8381625107937523703_struct *(*)(int, struct __yo_t_935386695610847210_struct)'
```

The other two tests in the file pass. A standalone program does the same:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
_fp_twice :: (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))(io.async((io2 : Io) => (x * i32(2))));
_fp_plus :: (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io2 : Io) => {
    s := String.from("abc");
    x + i32(s.len())
  })
);
_fp_run :: (fn(f : (fn(x : i32, io : Io) -> Impl(Future(i32, Io))), io : Io) -> i32)(io.await(f(i32(21), io), io));
main :: (fn(io : Io) -> unit)({
  a := _fp_run(_fp_twice, io);
  b := _fp_run(_fp_plus, io);
  println(`${a.to_string()} ${b.to_string()}`);
});
export(main);
```

With `--sanitize undefined --cc clang`, this aborts at the first call. Under
`--sanitize address --optimize 2` it prints `42 24` with rc 0.

The emitted C:

```c
// the callee's own definition: returns ITS state machine
static inline _file_…_sync_fut_t* yo_id_1719…(int32_t __yo_v_x, Io __yo_v_io);
// the slot: returns the generic Future interface
static inline int32_t yo_id_1475…(__yo_t_F* (*__yo_v_f)(int32_t, Io), Io __yo_v_io) {
  … ((__yo_t_F* (*)(int32_t, Io))__yo_v_f)((int32_t)(21), __yo_v_io) …
}
// the call site: the mismatch is hidden behind a cast to void*
yo_id_1475…((void*)(yo_id_1719…), __yo_v_io);
```

## Shapes (`--sanitize undefined --cc clang`; v0.2.69 and the `27431e4be` tree binary agree)

| Shape | Result |
| --- | --- |
| runtime parameter `f : (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))` given a named async fn (the test) | UBSan abort |
| the same parameter captured by an `io.async({ f }(e : Io) => e.await(f(…), e))` body | UBSan abort |
| function result `get :: (fn() -> (fn(x : i32, io : Io) -> Impl(Future(i32, Io))))(_fp_twice)`, then `get()(…)` | UBSan abort |
| struct field `Holder :: struct(f : (fn(…) -> Impl(Future(i32, Io))))` with `_fp_twice` also called directly | UBSan abort |
| the same field when `_fp_twice` is reached ONLY through the field | C compile error: `incompatible pointer types returning '…_sync_fut_t *' from a function with result type '__yo_t_F *'` (the definition is emitted with the interface result, while its body returns the state machine uncast) |
| `(mut(h) : (fn(…) -> Impl(Future(i32, Io)))) = _fp_twice; if(c, { h = _fp_three; }); h(…)` with `c == false` | UBSan abort: the call casts `h` to `_fp_three`'s concrete signature while `h` holds `_fp_twice` |
| the same local reassigned unconditionally | clean, but only by accident: each call casts to the function assigned last |
| a fn type taking an `Impl(Future(i32, Io))` PARAMETER, given a function with a `sink(fut) : Impl(Future(i32, Io))` parameter | clean |

## Root cause

A function whose declared result is `Impl(Future(T, E))` has two different C
spellings, and nothing converts between them.

1. **The definition returns its concrete state machine.** `_return_type_override`
   → `_async_override_return_type` (`src/codegen/functions/declarations.yo:622`,
   the override at `:656`) emits the prototype with `<block>_sync_fut_t*` /
   `<block>_state_t*`. That type is the resolved `Impl`, whose C name was
   preregistered at `src/codegen/exprs/async.yo:3465-3466`.
2. **The slot spells the generic Future interface.** The slot's type is an
   unresolved `Impl(Future(i32, Io))`, which the evaluator admits by the
   `_any_future_trait` exemption of `fn_type_unrepresentable_impl`
   (`src/types/utils.yo:2784`). `generate_function_prototype` lowers it to
   `__yo_t_<Future(i32, Io)>*`, so the parameter declaration and every call
   through the slot (the function-pointer cast in `generate_other_function_call`,
   `src/codegen/exprs/other_fn_call.yo:2677` onward) use
   `__yo_t_F* (*)(int32_t, Io)`.
3. **The coercion emits no conversion.** The argument is the bare C name
   (`_materialize_arg` → `_arg_fn_value_c_name`,
   `src/codegen/exprs/other_fn_call.yo:484-488` and `:549-557`). `_per_arg_cast`
   (`:927-968`, call site `:2520`) then casts it to
   `get_storage_type_string(<fn type>)`, which is `void*` for every `Func`
   (`src/codegen/utils/index.yo:1579`). The `void*` round-trip hides the
   mismatch from clang. Without it, clang rejects the argument
   (`-Wincompatible-function-pointer-types` is an error by default). The
   function-result and local paths store the value as `void*` too, so they
   hide it the same way.

The interface struct (`__YO_FUTURE_PREFIX; T result;`) is a common initial
sequence of every `_sync_fut_t` / `_state_t`, and both are data pointers with
one ABI. That is why the program runs correctly, and why ASan sees nothing.
The call is still C11 6.3.2.3p8 undefined behavior, and clang ≥ 17's
`-fsanitize=function` (part of `-fsanitize=undefined`) traps it.

The field-only compile error comes from the same split, reached from the
other side. When `_async_override_return_type` resolves no block for a
function that is collected only as a value, the prototype falls back to the
interface spelling while the body still returns the state machine uncast.

The mutable-local shape is the evaluator side of the same gap. Under #1298, a
local annotation takes its initializer's own concrete function type, and an
assignment re-stamps it, so after a branch the call site's cast names
whichever function the evaluator saw last.

## Fix direction

Codegen should hold one invariant: **a function-pointer VALUE whose signature
mentions `Impl(Future(...))` always has the ERASED signature**, with every
resolved `Impl(Future(T, E))` spelled as the generic Future interface pointer.
Direct calls keep the concrete prototype.

- Where a `FuncVal` becomes a runtime value (`_arg_fn_value_c_name` /
  `_materialize_arg`; the `FuncVal` arm of `generate_comptime_value`,
  `src/codegen/exprs/comptime_value.yo:583`; constructor field arguments; a
  `return` of a function value), emit
  `static inline __yo_t_F* __yo_fnval_thunk_<fn>(params) { return (__yo_t_F*)<fn>(params); }`
  once per function, defined with the erased signature, and use it instead of
  the function whenever the erased and emitted prototypes differ. This is the
  pattern `dispose_fn_thunk` (`src/codegen/functions/constructors.yo:156`) and
  the dyn-wrapper fix established in
  `issues/fixed/runtime-callbacks-are-called-through-an-incompatible-function-pointer-type.md`.
- A call through a function-pointer value (a parameter, a field, a local, a
  call result) casts to the erased prototype, never to one function's
  concrete one. This fixes the mutable-local shape.
- `_per_arg_cast` spells a function-typed parameter with its declarator
  (`generate_function_prototype(pt, "(*)")`) instead of `void*`, so that any
  future mismatch becomes a C compile error rather than silent UB.
- A function collected only as a value still gets the concrete prototype, or,
  if the interface prototype stands, a return cast, so the field-only shape
  compiles.

## Test

`tests/async_future_parameter.test.yo` ("two async functions through one
function-typed parameter") already fails under `YO_TEST_SANITIZE=undefined`.
The fix should add the field, result, captured-parameter and
conditionally-reassigned-local shapes above to the same file. The weekly
UBSan job is the standing gate.
