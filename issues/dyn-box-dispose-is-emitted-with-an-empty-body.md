# A value boxed into a `Dyn` is never dropped — `__yo_dispose___yo_dyn_box_<T>` has an empty body

**Status:** OPEN
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit —
a three-line `AnyError` program leaks under `leaks -atExit`.
**Severity:** memory-unsafety (unconditional leak; no use-after-free — the box
itself is freed, only the value inside it is not dropped).

## Symptom

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

main :: (fn(io : Io) -> unit)({
  (inner : AnyError) = dyn(`disk full`);
  println(`done`);
});
export(main);
```

```
$ yo compile d4.yo --optimize 2 --allocator system -o d4.out
$ leaks -atExit -- ./d4.out
Process 73848: 2 leaks for 80 total leaked bytes.
STACK OF 1 INSTANCE OF 'ROOT LEAK: <malloc in __yo_user_main>':
    2 (80 bytes) ROOT LEAK: <malloc in __yo_user_main 0xb01034000> [48]
```

The same program with a plain `String` local instead of the `AnyError` leaks
`0 leaks for 0 total leaked bytes`.

It is not specific to `String`, and not specific to a local: the blessed
`exn.throw(dyn(err))` idiom leaks its payload too —

```rust
{ AnyError, Exception, Error } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

IoErr :: enum(NotFound(path : String));
impl(IoErr, ToString(to_string : (fn(inout(self) : Self) -> String)(match(self, .NotFound(p) => `not found: ${p}`))));
impl(IoErr, Error());

risky :: (fn(exn : Exception) -> i32)(exn.throw(dyn(IoErr.NotFound(path : `/tmp/x`))));

main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (err -> { println(`caught: ${err}`); unwind(()); }));
  _r := risky(exn);
  println(`done`);
});
export(main);
```

`2 leaks for 64 total leaked bytes`, while the identical program throwing a
PAYLOAD-FREE variant (`IoErr :: enum(NotFound)`) leaks 0. The leaked bytes are
the boxed value's own RC allocations.

## Root cause

The dyn box's dispose function is emitted with nothing in it. From the generated
C (`d4.out.c`):

```c
static void __yo_dispose___yo_dyn_box___yo_t4(void* ptr) {
  __yo_dyn_box___yo_t4* box = (__yo_dyn_box___yo_t4*)ptr;
}
```

Everything AROUND it is correct — the scope-end drop runs
(`__yo_decr_rc((void*)(inner).data)`) and the dispatch is wired
(`case 3: __yo_dispose___yo_dyn_box___yo_t4(ptr); return;`) — so the box is freed
and `box->value` is simply never dropped.

`generate_dyn_box_functions` (`src/codegen/functions/dyn.yo:166-172`):

```rust
em.emit_string_line(`static void __yo_dispose_${box_name}(void* ptr) {`);
em.emit_string_line(`  ${box_name}* box = (${box_name}*)ptr;`);
match(
  get_drop_function_for_type(impl_entry.concrete_type.clone(), context),
  .Some(drop_c) => em.emit_string_line(`  ${drop_c}(box->value);`),
  .None => ()
);
em.emit_line("}");
```

`get_drop_function_for_type` (`src/codegen/exprs/drop_dup.yo:47-49`) resolves
only a USER `___drop` METHOD through `_method_c_name` (`:38-41`). Most types do
not have one: the compiler drops a `String` (a newtype over
`Option(ArrayList(u8))`), an enum with RC payloads, a tuple, an array
STRUCTURALLY, emitting the drop inline via
`generate_drop_code_for_value` (`src/codegen/exprs/drop_dup.yo:175`) — which is
exactly what the control program's String local gets:

```c
switch ((_file____priv_temp_9304).tag) {
  case __YO_T1_SOME: { __yo_decr_rc((void*)((_file____priv_temp_9304).data.Some.value)); …
```

So the `.None => ()` arm silently skips the drop for every value type that
relies on structural teardown — the `true => ""` / silent-fallback class in the
drop lowerings. That covers `impl(String, Error())` (the blessed idiom of
`std/error.yo:19`), every ``exn.throw(dyn(`…`))`` in std and in the compiler, and
every error enum carrying a `String`.

Second, smaller defect in the same six lines: the drop lookup passes the
UNRESOLVED `impl_entry.concrete_type`, while the box typedef and constructor
above it (`src/codegen/functions/dyn.yo:120-164`) use
`dyn_concrete_res := resolve_some_type_to_concrete(impl_entry.concrete_type)`.
A concrete that arrives as a `SomeT` therefore misses the registry lookup even
when a user `___drop` exists.

## Fix

Fall back to the structural drop, and use the resolved concrete for both
lookups:

```rust
match(
  get_drop_function_for_type(dyn_concrete_res.clone(), context),
  .Some(drop_c) => em.emit_string_line(`  ${drop_c}(box->value);`),
  .None => {
    dc := generate_drop_code_for_value(String.from("box->value"), dyn_concrete_res.clone(), context);
    if(dc.len() > usize(0), {
      em.emit_string_line(`  ${dc};`);
    });
  }
);
```

Two things to check while wiring it: `generate_drop_code_for_value` emits some
shapes (arrays, nested structs) as its OWN lines through the emitter rather than
returning an expression, so confirm those lines land inside the dispose body
(the emit cursor is mid-body at that point) and not before its opening brace; and
the `__yo_ref_header_t` at the head of the box must not be touched — only
`box->value`.

Also verify the DUP side stays balanced: `__yo_dup___yo_t0(dyn)` increments the
BOX's refcount only, which is correct, so this fix must not add a matching dup
anywhere — the box owns exactly one copy of the value.

## Regression test

The leak is invisible on macOS (ASan cannot arm on this box), so gate it two
ways:

1. `leaks -atExit` on the three-line reproducer goes 2 → 0, and the throw
   reproducer 2 → 0, with the payload-free variants staying at 0 (the
   over-drop canary).
2. A test in `tests/dyn.test.yo` / `tests/error.test.yo` that boxes a
   String-carrying value into a `Dyn`, drops it, and is covered by the CI
   LeakSanitizer verdict on Linux.

Then re-run the 50-file list in `issues/self-hosted-emit-leaks-remaining-classes.md`
— that umbrella names `tests/dyn.test.yo` (`:53`) and `tests/error.test.yo`
(`:56`) among its LeakSanitizer failures and names this exact class ("audit every
silent fallback in the drop lowerings first") without ever locating it. Expect
several of the 50 to clear.

## Not a breaking change

Emission-only; no source-level behaviour changes except that memory is now
released.
