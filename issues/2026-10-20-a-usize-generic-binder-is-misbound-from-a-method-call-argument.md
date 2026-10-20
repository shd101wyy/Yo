# A `usize` generic binder is misbound from a method-call argument

**Severity:** S2 — `f(x.m())` for `f :: fn(generic(N : usize), a : Array(T, N))` fails with E0604 ("Function body has type `Type`") whenever the argument is a dot-method call, so `ArrayList(T).from(arr.clone())` must be written with the clone bound to a local first.

**Status:** open. Found 2026-10-20 while landing `ArrayList(T).from`
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md` B3): decision 8 of the v0.2.68
schedule spells the copying form `ArrayList(T).from(arr.clone())`, which is
exactly this shape. Pre-existing: `ArrayList.from_array(&arr.clone())` fails
the same way on develop `7def2203b`, and the seed v0.2.66 has it too.

## Reproducer

`issues/repros/2026-10-20-a-usize-generic-binder-is-misbound-from-a-method-call-argument.yo`:

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

## Where to look

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

## Workaround

Bind the argument first: `c := arr.clone(); ArrayList(T).from(c)`.
