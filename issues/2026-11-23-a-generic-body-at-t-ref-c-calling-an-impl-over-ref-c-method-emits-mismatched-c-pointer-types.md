# A generic body at `T := &C` that calls an `impl(&C, …)` method emits mismatched C pointer types

**Severity:** S1: `yo check` accepts the program and the C compiler rejects the emitted code. The program is safe user code: a user trait, an impl over `&C`, and a generic caller.

Found 2026-11-23 on branch `fix/receiver-riders` (VERDICTS-75 riders) while re-deriving `issues/2026-11-23-a-method-call-on-a-generic-t-bound-to-a-reference-type-unifies-the-receiver-with-the-referent.md`. On that branch the method spelling `t.view()` type-checks: rider r2 tries a receiver's own reference type first. The program then fails in C. The qualified spelling `View.view(t)` already passed check and failed in C on the v0.2.79 seed, with a different error, so the codegen fault predates the branch.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
C :: struct(v : Rc(X));
View :: trait(view : (fn(self : Self) -> Option(&Rc(X))));
impl(&C, View(view : (fn(self : Self) -> Option(&Rc(X)))(.Some(&self.v))));
see :: (fn(generic(T : Type), t : T, where(T <: View)) -> Option(&Rc(X)))(t.view());
main :: (fn() -> unit)({
  c := C(v : Rc.new(X(s : String.from("abc"))));
  rc := &c;
  o := see(rc);
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

`t.view()` on `fix/receiver-riders` (check passes):

```text
error: passing 'const __yo_t_…_struct *' to parameter of type '__yo_t_… *' discards qualifiers [-Werror,-Wincompatible-pointer-types-discards-qualifiers]
static inline … __yo_fs_…(__yo_t_… const * __yo_v_t) { … yo_id_…(__yo_v_t); … }
static inline … yo_id_…(__yo_t_…* __yo_v_self) { … }
```

`View.view(t)` on the v0.2.79 seed and on the branch (check passes):

```text
error: use of undeclared identifier '__yo_t_2114479992896554854'
```

The concrete call `rc.view()` compiles and prints `OUT: 3` on both.

## Root cause (to confirm)

The specialization of `see` at `T := &C` lowers its by-value parameter `t : T` as `C const *`. The `impl(&C, View)` method's by-value `self : Self` (`Self = &C`) is lowered as a non-const `C *`. The two spellings of one type `&C` get two C types. The qualified spelling also names a C type that is never declared, so the specialization's type table misses the reference instance.
