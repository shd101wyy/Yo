# `dyn(f)` of a named function value emits invalid C

**Severity:** S2 — a valid `Dyn(Fn(...))` built from a `fn(...)` value passes `check` and dies in the C compiler; wrapping it in a closure literal (`dyn(s => f(s))`) works.

**Status:** FIXED 2026-10-13 (stacked on #1339, decision 44).
**Found:** 2026-10-10, writing the runtime canary for
`issues/fixed/a-function-argument-is-not-checked-against-a-function-typed-parameter.md`
(`tests/dyn.test.yo`). Pre-existing: the v0.2.56-era compiler at `c9bc66987` emits the same C.

## Repro (`issues/repros/dyn-of-a-named-function-value.yo`)

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
lent :: (fn(s : &String) -> usize)(s.len());
main :: (fn() -> unit)({
  s := String.from("four");
  (h : Dyn(Fn(s : &String) -> usize)) = dyn(lent);
  println(`${h(&s)}`);
});
export(main);
```

`yo check` exits 0; `yo compile --optimize 2` fails in clang:

```
error: expected ')'
  } __yo_dyn_box_unknown_fn(s : &String) -> usize;
```

The same shape fails for an imported function and for an `Impl(Fn(...))`
parameter bound to a named `fn` and boxed in the callee (`dyn(f)` there sees a
`SomeT` resolving to the `fn(...)` type).

## Root cause

The evaluator was right: `dyn(lent)` auto-boxes the value as
`Rc(fn(s : &String) -> usize)`, whose one field is the code pointer (a
function-typed field lowers to `void*`). Codegen had three gaps, all for a dyn
impl whose concrete type is a `fn(...)`:

1. **No C name.** Every dyn emitter names the concrete through
   `get_type_c_name(type_key(concrete))`, and a function type has no registered
   C type, so each fell back to `unknown_<type_key>`, splicing the printed
   signature (`fn(s : &String) -> usize`) into the box typedef, its ctor and
   dispose, the TypeId static and the vtable. The two registration routes also
   disagreed: the collection pass (re-keyed by `fixup_dyn_impl_keys`) produced
   `unknown_fn(...)` while the `dyn(...)` emitter's `_concrete_c_name` produced
   `unknown_` (an empty type id), so two wrappers and two vtables were emitted
   for one impl.
2. **No call slot for a code pointer.** The `Fn` `call` wrapper had a branch
   for a dyn'd closure (its capture struct is the box payload; the closure's C
   function comes from `impl_closure_call_map`) and a fat-pointer branch
   (`box->field.call(box->field.data, ...)`). A `fn(...)` payload fell into
   the fat-pointer branch and dereferenced its `void*` as a struct.

## Fix

- `dyn_concrete_c_name` (`src/codegen/utils/index.yo`) names a dyn concrete:
  its registered C name, else, for a `fn(...)` type reached through any
  `SomeT` resolutions (`dyn_concrete_func_type`), `__yo_fn_<fnv1a64 of its
  type_key>`. The impl key at the `dyn(...)` site, `fixup_dyn_impl_keys`, the
  box typedef, ctor and dispose, and the TypeId static and vtable all name the
  concrete through it, so one function signature keys one impl.
- The `call` wrapper (`generate_dyn_wrapper_functions`,
  `src/codegen/functions/dyn.yo`) gets a code-pointer branch: it casts the boxed
  pointer to the function's own prototype (`generate_function_prototype(f,
  "(*)")`, as a call through a `fn(...)` value is spelled) and calls it,
  passing each argument at the pointer level the prototype takes it at
  (`fn_abi_param_is_ptr`) where the slot's spelling differs. A
  `Dyn(FnOnce(...))` releases the box after the call; the pointer owns nothing.

Boxes, wrappers and vtables are keyed per signature, not per function: the
wrapper calls whatever pointer the box holds, so two functions of one
signature share them soundly (`tests/dyn.test.yo` calls two).

Tests: `tests/dyn.test.yo` ("dyn of a named function calls the function",
"dyn of a generic type's function, another module's function and an Impl(Fn)
parameter") and `tests/closure.test.yo` ("decision 44: dyn(named_fn) at the
binding, field, argument and result compiles and runs"); all fail to compile
before the fix.

## Not covered

A generic type's function taken as a value (`_Cell(i32).make`,
`ArrayList(i32).new`) is not emitted with or without `dyn`:
`issues/a-generic-types-function-taken-as-a-value-is-not-emitted.md`.
A generic function is not a first-class value: `dyn(identity)` for
`identity :: (fn(generic(T : Type), x : T) -> T)` is rejected at `check`
(E0601), as the same function is in a `fn(x : i32) -> i32` or an
`Impl(Fn(...))` binding. Passing it to an `Impl(Fn(...))` PARAMETER passes
`check` and fails in codegen: `issues/a-generic-function-passed-to-an-impl-fn-parameter-fails-in-codegen.md`.
A `Dyn(Fn(...), Send)` of a named function is rejected at `check` because the
auto-box's `arc` cannot judge `Send` on a named function's value:
`issues/arc-of-a-named-function-value-fails-its-send-bound.md`.
