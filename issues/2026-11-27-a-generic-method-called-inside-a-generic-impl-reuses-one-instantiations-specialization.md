# A generic method called inside a generic impl's method reuses one instantiation's specialization for every instantiation (invalid C)

**Severity:** S2 — `yo check` passes and the emitted C does not compile (a value of one instantiation's type is passed where another's is expected); no wrong code runs, but a nested generic type cannot render through `Formatter.write`.

Found 2026-11-27 while gating VERDICTS-78 Q3 PR 1 (`ToString` → `Display`/`Debug`, lane v81-display-pr1): `ArrayList(Option(i32))` rendered through a `Display` impl that called `f.write(value)` failed to compile. Reproduced with the v0.2.80 seed and with the tree compiler, with no std involved.

## Reproducer

`tmp/fixme.yo`:

```yo
Show :: trait(show : (fn(self : &Self, out : &mut Sink) -> unit));
Sink :: struct(n : i32);
impl(
  Sink,
  put : (fn(generic(T : ?Sized), self : &mut Self, v : &T, where(T <: Show)) -> unit)(T.show(v, self))
);
impl(
  i32,
  Show(
    show : (
      (self, out) -> {
        out.n = (out.n + self.*);
      }
    )
  )
);
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), where(T <: Show), W(T), Show(show : ((self, out) -> out.put(&self.v))));
main :: (fn() -> unit)({
  mut(s) := Sink(n : i32(0));
  w := W(W(i32))(v : W(i32)(v : i32(5)));
  s.put(&w);
  _ := s.n;
});
export(main);
```

```text
$ yo compile tmp/fixme.yo -o fixme
fixme.c:2152:44: error: passing '__yo_t_5063275384088113671' (aka 'struct __yo_t_5063275384088113671_struct') to parameter of incompatible type '__yo_t_8866777745494437917' (aka 'struct __yo_t_8866777745494437917_struct')
yo: error: compile: C compiler failed (exit 1) on fixme.c
```

`yo check tmp/fixme.yo` reports no error.

## What the C shows

`W(W(i32)).show` calls `put<W(i32)>`, which calls `W(i32).show`, whose `out.put(&self.v)` must be `put<i32>`.
The emitted `W(i32).show` calls `put<W(i32)>` instead, the specialization the OUTER instantiation's call site
resolved to: the one call node `out.put(&self.v)` in the generic impl body is resolved once and that
resolution is reused for the other instantiation.

Controls (same file shape):

- `T.show(&self.v, out)` (type-qualified trait call) instead of `out.put(&self.v)`: compiles and runs.
- `self.v.show(out)` (receiver trait call): compiles and runs.
- The same nesting through two NON-generic types (`L` holding a `P` holding an `i32`): compiles and runs.
- The v0.2.80 seed and the tree compiler fail identically.

So the defect is specific to a call of a method that has its own `generic(...)` parameters, made inside a
generic impl's method body, when the method's type argument depends on the impl's binder.

## Root cause (not yet located)

Most likely the call node's recorded callee (its `ExprInfo`, shared by node id across specializations of
the generic impl's method) is read back by the second specialization instead of being re-resolved. Not
investigated further in the Q3 lane.

## Impact on Q3

`Formatter.write(&v)` / `write_debug(&v)` are generic methods of exactly this shape. The std impls of PR 1
(`Option`, `Result`, `ArrayList`, `Array`) and `derive(Debug)` call the child's own `fmt` / `debug_fmt`
instead, so std nests correctly; a user generic impl that calls `f.write(&self.field)` hits this bug.

## Test

To add with the fix: the reproducer as a runtime test (`tests/generic-impl-generic-method-call.test.yo` or a
row in `tests/impl-ref.test.yo`), plus `${xs}` of an `ArrayList(Option(i32))` through a user impl that calls
`f.write`.
