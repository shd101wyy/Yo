# An impl on an `Rc(RefCell(T))` alias is not found by a method call written above it

**Severity:** S3. A method call on a value of an `Rc(RefCell(T))` alias, written in the module above the
`impl(Alias, ...)` that declares the method, fails with E0610 "No method". Moving the `impl` above its first use
avoids it. `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` says `impl` registration is order-independent within a
module, so the write order should not matter. The same call made from another module, after the module has
finished evaluating, works.

> Found 2026-11-05 while migrating `Environment`/`Frame`/`FrameNameIndex`/`WhereClauseConstraints` to
> `Rc(RefCell(data))` (V5 part B, VERDICTS-22). `src/env.yo` now places those impls before the first use. The
> seed v0.2.74 shows it.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ RefCell } :: import("std/sync/refcell");
EnvData :: struct(n : usize);
Env :: Rc(RefCell(EnvData));
read_n :: (fn(e : &Env) -> usize)(e.n());
impl(
  Env,
  n : (fn(self : &Self) -> usize)(self.with(d => d.n))
);
main :: (fn() -> unit)({
  e := Rc.new(RefCell(EnvData).new(EnvData(n : usize(7))));
  println(read_n(&e));
});
export(main);
```

```text
error[E0610]: No method "n" on Rc(RefCell(EnvData)): the type has no field or method with that name. `e` is a Rc(RefCell(EnvData)); its payload RefCell(EnvData) has no field or method "n" either.
  --> e.yo:5:36
```

With the `impl` moved above `read_n`, the program prints `7`.

## Root cause (suspected)

On a method miss, the evaluator forces pending `impl` definitions by the receiver type's head name
(`type_head_name_for_impl_forcing`, `src/evaluator/context.yo`). The pending `impl(Env, ...)` is recorded under
the head atom `Env`. The receiver's type prints as `Rc(RefCell(EnvData))`, whose head is `Rc`. The two never
match, so the impl is only registered when the walk reaches it in order.

A struct alias such as `X :: Rc(XData)` does not hit this: a method on `XData` is found through `Rc`'s deref,
whose head is `XData`.

## Fix direction

Record a pending `impl` whose receiver is an alias under the head of the alias's value as well (`Rc`). The
alternative is for the miss path to force pending impls whose receiver alias evaluates to the receiver's type.

A test lands with the fix: the reproducer above, as a `tests/` case that fails before the fix and prints `7`
after it.
