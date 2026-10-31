# An effect-escape drop names a later local that a same-named pattern binding shadows in C

**Severity:** S2 — a valid program that `check` accepts fails in the C compiler; were the two bindings the same C type, the escape path would release the wrong value.

Found by the static-argument-inference B2 sweep (2026-10-30): a local `uc_res`
added at the end of `_infer_unapplied_ctor_receiver`
(`src/evaluator/calls/function.yo`), in a function that already binds a
pattern variable `uc_res` in an earlier `match` arm, broke `yo build` with the
v0.2.73 seed:

```text
yo.c:743714:37: error: member reference type '__yo_t_16203699947289399214 *' is a pointer; did you mean to use '->'?
 743714 | __yo_decr_rc((void*)((__yo_v_uc_res).__yo_v_preevaluated));
```

The branch renamed the local (`uc_decided`); the defect is open.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
nonempty :: (fn(s : &String) -> bool)(s.len() > usize(0));
Named :: struct(name : String, n : usize);
make :: (fn(o : Option(String)) -> Named)({
  k := match(o, .Some(res) => cond(nonempty(&res) => usize(1), true => usize(0)), .None => usize(0));
  res := Named(name : String.from("x"), n : k);
  res
});
main :: (fn() -> unit)({
  r := make(Option(String).Some(String.from("a")));
  println(&r.n);
});
export(main);
```

`yo check` accepts it; `yo compile` (v0.2.73) fails in clang:

```text
error: member reference type '__yo_t_5764540034370129219' is a pointer; did you mean to use '->'?
 2503 | if (((__yo_v_res).__yo_v_name) != NULL) { __yo_decr_rc((void*)((__yo_v_res).__yo_v_name)); }
```

## Root cause (as far as read)

`nonempty(&res)` is a direct call through an atom of function type, so
`_call_may_unwind` (`src/codegen/exprs/other_fn_call.yo`) brackets it with the
effect-escape check. The check's early return emits "Drop consumed variables
(unwind propagation)", and that list carries the function-level local `res`,
which the function consumes later (its tail returns it) and which is not
declared yet at this point. The emitted drop names it as `__yo_v_res`, which in
C resolves to the arm's pattern binding (`String*`), so the field access does
not compile. The list should hold only consumed variables already declared at
the escape point.
