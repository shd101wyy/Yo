# A `usize` generic binder is misbound from a method-call argument

**Severity:** S2 — `f(x.m())` for `f :: fn(generic(N : usize), a : Array(T, N))` fails with E0604 ("Function body has type `Type`") whenever the argument is a dot-method call, so `ArrayList(T).from(arr.clone())` must be written with the clone bound to a local first.

**Status:** FIXED 2026-10-22 on `fix/generic-binder-inference` (see "Fix"). Found 2026-10-20 while landing `ArrayList(T).from`
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md` B3): decision 8 of the v0.2.68
schedule spells the copying form `ArrayList(T).from(arr.clone())`, which is
exactly this shape. Pre-existing: under the v0.2.66 seed,
`count2(&arr.clone())` with
`count2 :: fn(generic(N : usize), arr : &Array(String, N))` (the borrowed
shape of the deleted `ArrayList.from_array`) fails the same way; the
reproducer below fails under both the seed and this branch's tree compiler,
whose changes do not touch generic inference.

## Reproducer

`issues/repros/2026-10-20-a-usize-generic-binder-is-misbound-from-a-method-call-argument.yo` (measured before the fix):

```yo
count :: (fn(generic(N : usize), arr : Array(i32, N)) -> usize)(N);
Wrap :: struct(a : Array(i32, 3));
impl(Wrap, get : (fn(self : &Self) -> Array(i32, 3))(self.a));
get2 :: (fn(w : &Wrap) -> Array(i32, 3))(w.a);
main :: (fn() -> unit)({
  a := [i32(1), i32(2), i32(3)];
  w := Wrap(a : a);
  (x1 : usize) = count(get2(&w)); // ok
  (x2 : usize) = count(Wrap.get(&w)); // ok
  (x3 : usize) = count(w.get()); // E0604
});
export(main);
```

```text
error[E0604]: Function body has type `Type`, but the declared result type is `usize`.
  --> count :: (fn(generic(N : usize), arr : Array(i32, N)) -> usize)(N);
note: in `count`, instantiated here
  --> (x3 : usize) = count(w.get());
```

What distinguishes the failing argument: a plain call (`get2(&w)`), the static
spelling of the same method (`Wrap.get(&w)`), a local (`count(a)`), an array
literal (`count([1, 2, 3])`) and a generic identity call (`count(idf(a))`) all
bind `N = 3`. Only the dot-method form `w.get()` (and `a.clone()`) binds `N` to
a type. A type binder through the same shape is fine
(`fn(generic(T : Type), o : Option(T))` with `w.opt()`).

The same misbind surfaces with a different code when the body uses `N` as a
value before returning it. `ArrayList(i32).from(arr.clone())` fails with
E0610 reported INSIDE std, not at the caller's line, so the message does not
point at the workaround:

```text
error[E0610]: No matching call found for operator "==" with receiver type "Type"
  --> std/collections/array_list.yo  (`cond((N == usize(0)) => …)` in `ArrayList.from`)
```

The `from` doc comment named this issue and the working spelling.

## Where to look (as filed)

The FuncVal call arm evaluates each argument with the declared parameter type
as the expected type (`src/evaluator/calls/function.yo`, "Evaluate the arg with
expectedType = the DECLARED PARAM TYPE"). For `Array(i32, N)` that expected
type still carries the unresolved length variable `N` (it is not a SomeT, so
the "skip abstract expected types" arm does not drop it). The working
hypothesis, not yet confirmed: the dot-method dispatch path adopts that
expected type for its result, so the argument's recorded type is
`Array(i32, N)` with `N` abstract, the structural synthesizer
(`_fv_synthesize_arg_into` / `_scratch_len_binding`) cannot read a length from
it, and a later fallback binds `N` to a `TypeVal`. The static form goes through
a path that ignores the expected type.

## Workaround (no longer needed)

Bind the argument first: `c := arr.clone(); ArrayList(T).from(c)`.

## Root cause

The working hypothesis was right about the path and wrong about where the
adoption happens. `w.get()` is a dot-method call, so it does not go through
the inline FuncVal arm: the method arm calls
`try_to_call_function_with_arguments` (`src/evaluator/calls/helper.yo`), and
its Step 10 synthesizes the call's return type against the caller's expected
type and then ADOPTS the expected type as the call's result when the two are
compatible and the expected type is "fully concrete". The concreteness test
asked for no SomeT anywhere in the type (the deep test added by
`issues/fixed/generic-fn-forall-unresolved-when-argument-is-a-method-call.md`
for `Option(U)`). A value binder is not a SomeT: `Array(i32, N)` carries `N`
in the Array node's length-variable field, which `get_all_some_types` does
not list. So `Array(i32, N)` passed as concrete, the method call's recorded
type became `Array(i32, N)` with `N` unresolved, and `count`'s structural
inference had no length to read, leaving `N` bound to a type. Every
non-method spelling in the table above takes the inline FuncVal arm, which
has no Step 10 adopt, so none of them failed.

## Fix

Step 10's adopt also requires `!_type_has_array_len_var(&et.ty)`, the
existing helper the rest of `helper.yo` already uses for an unresolved
length variable (Step 9b's return-type acceptance among them). The method
call keeps its own `Array(i32, 3)`, and `count` binds `N = 3`.

Measured with a tree build (`fix/generic-binder-inference`): the reproducer
checks (rc 0, was E0604); a two-length variant in one body
(`count(w3.get())`, `count(w4.get())`, `count(a2.clone())`) compiles and its
binary asserts 3, 4 and 2; `ArrayList(String).from(arr.clone())` checks
(was E0610 inside `std/collections/array_list.yo`).

The workaround sites that named this issue now use the inline spelling: the
`ArrayList.from` doc comment (`std/collections/array_list.yo`), the
`ArrayList.from` clone test (`tests/collection_constructors.test.yo`), the
core-patterns cheatsheet (`.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`),
and the B3 note in `plans/backlog/MACRO_AND_ISO_REMOVAL.md`.

## Test

- `tests/type_soundness.test.yo`: "soundness canary: a method-call argument
  binds the callee's length parameter" (`N = 3` and `N = 4` through two method
  calls in one body, `N = 2` through `.clone()`).
- `tests/collection_constructors.test.yo`: "ArrayList.from moves a named
  array, and a clone of it keeps the array" now passes `arr.clone()` inline.

Before the fix (develop `6cd3495c5`, tree build): `collection_constructors`
fails all 16 tests at module evaluation with `error[E0610]: No matching call
found for operator "==" with receiver type "Type"` at
`std/collections/array_list.yo:235`; the length canary's program fails with
E0604 (`tmp` probe, same shape). After: both files pass.
