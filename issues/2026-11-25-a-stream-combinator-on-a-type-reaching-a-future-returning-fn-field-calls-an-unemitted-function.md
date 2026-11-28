# A `Stream` combinator on a type whose fields reach a future-returning function type calls a function that is never emitted

**Severity:** S2 — a program `yo check` accepts fails the C compile: `s.map(f)` calls a specialization the C never defines.

Filed 2026-11-25 by the `v81-io-1b` lane. Pre-existing: develop `8da9761d1` fails the same way when the
struct holds the prelude `Io` (its old fields were the `async`/`await` builtins). IO-1b made `Io` a
`{ ctx, vtable : *IoVTable }` value whose table entries return `IoFuture`, so every struct holding an
`Io` now reaches such a field type.

## Reproducer

`issues/repros/2026-11-25-a-stream-combinator-on-a-type-reaching-a-future-returning-fn-field-calls-an-unemitted-function.yo`:

```yo
pragma(Pragma.AllowUnsafe);
IO_future :: import("std/sys/future");
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ Stream } :: import("std/async/stream");
Ev :: struct(name : String);
derive(Ev, Clone);
MyVT :: struct(f : (fn(ctx : ?*void) -> IoFuture));
MyIo :: struct(ctx : ?*void, vtable : *MyVT);
_St :: struct(_io : MyIo, n : i32);
noop :: (fn(ctx : ?*void) -> IoFuture)(IO_future.completed(i32(0)));
VT0 := MyVT(f : noop);
namesOf :: (fn(e : &Ev) -> String)(e.name.clone());
Src :: struct(_cell : _St);
impl(
  Src,
  Stream(
    Item : Ev,
    next : (fn(self : &mut Self, io : Io) -> Impl(Future(Option(Ev), Io)))(
      io.async({ self : &mut self.* }(io : Io) => {
        Option(Ev).Some(Ev(name : String.from("x")))
      })
    )
  )
);
main :: (fn(io : Io) -> unit)({
  s := Src(_cell : _St(_io : MyIo(ctx : .None, vtable : addr_of(VT0)), n : i32(21)));
  m := s.map(namesOf);
  println("built");
});
export(main);
```

```bash
yo compile repro.yo --std-path ./std -o out1   # tree-built compiler on the IO-1b branch
```

```text
out1.c:8420:72: error: call to undeclared function '__yo_fs_18071444179145580829'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
out1.c:8420:30: error: initializing '__yo_t_6029724209614356964' (aka 'struct __yo_t_6029724209614356964_struct') with an expression of incompatible type 'int'
```

The same program with `MyVT`'s field returning `i32` (and `noop` returning `i32(0)`) prints `built`; so
does the program with `_St` holding `_io_vtable : *void` in place of the struct pointer. The `Io` the
`main` parameter carries is not the trigger: `Src` never stores it.

## Root cause (partial)

The call `s.map(namesOf)` is lowered to the C name of `map`'s specialization at `Src`, and that
specialization's body is never emitted. What differs from the passing variant is only a function type
whose result is a `Future` `Impl`, reached through `Src`'s field types (through a pointer). The
specialization's emission is gated on something that classifies the receiver type by walking its fields
and treats a future-returning function type as making the type async-shaped; not yet located.

## Workaround in std

`std/fs/watch.yo`'s `_WatcherState` holds its `Io` as two words (`_io_ctx : ?*void`,
`_io_vtable : *void`) and rebuilds the `Io` where it calls `stop` and `close`; `Watcher` implements
`Stream`, and `tests/fs/watch.test.yo` maps one. Restore the `_io : Io` field when this is fixed.

## Test

None yet (the lane that found it does not fix it). The fix adds the reproducer as a test under
`tests/async/` that prints through `map`.
