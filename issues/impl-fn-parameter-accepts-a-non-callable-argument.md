# An `Impl(Fn(...))` parameter accepts a non-callable argument — the integer is cast to a function pointer and called

**Status:** OPEN
**Severity:** memory-unsafety. `yo check` says OK, `yo compile --optimize 2`
emits, links and runs, and the emitted C casts an `int32_t` to a function
pointer and jumps through it. No diagnostic fires at any stage.
**Found:** 2026-09-04, std-API audit re-measurement, while distilling async
reproducers — `io.async({ ... })` (a bare block where a closure belongs) was
accepted by the evaluator, which led to the general case below.

## Symptom 1 — a non-callable bound to `Impl(Fn(...))` becomes a call through address 5

```rust
{ println } :: import("std/fmt");

apply :: (fn(f : Impl(Fn(x : i32) -> i32)) -> i32)(f(i32(3)));

main :: (fn() -> unit)({
  r := apply(i32(5));
  println(r.to_string());
});

export(main);
```

```
$ yo check implfn.yo
check: implfn.yo — evaluator OK

$ yo compile implfn.yo --optimize 2 -o implfn.out
Using system allocator                       # 0 errors, links

$ ./implfn.out
$ echo $?
138                                          # SIGBUS
```

The emitted C says exactly what happened:

```c
static inline int32_t yo_id_7473_rtparam0_i32_ret_i32(int32_t f) {
  __yo_effect_escaped = 0;
  int32_t _file____priv_temp_9305 = (((int32_t (*)(int32_t))f)((int32_t)(3)));
  ...
}
```

The `i32` argument is lowered into the parameter slot unchanged and the call site
casts it to `int32_t (*)(int32_t)` and invokes it. `apply(i32(5))` therefore
transfers control to address `0x5`. An attacker-influenced integer in that
position is an arbitrary indirect-branch primitive; a benign one is a crash with
no Yo-level explanation.

Expected: `yo check` rejects the call — `i32` does not implement
`Fn(x : i32) -> i32` — with a message naming the constraint, in the shape
`src/evaluator/types/field.yo:534-543` already uses when it rejects
`Impl(Fn(...))` in field position.

**Accidental containment, worth recording**: when the wrongly-bound type is not
C-convertible to a pointer the C compiler catches it. The same file with
`apply(String.from("nope"))` fails the build with
`implfn5.out.c:1646:61: error: operand of type '__yo_t0' (aka 'struct __yo_t1_struct') where arithmetic or pointer type is required`.
So the SILENT face is confined to
scalar arguments — integers, `bool`, `char`, pointers — which is the common case
and the dangerous one. This is the same containment shape recorded for C29
(`issues/generic-type-var-rebinds-per-argument.md`).

## Symptom 2 — `io.async` takes a bare block, or any value at all

`Io.async`'s declared signature (`std/prelude.yo:10361`) is

```rust
async : (fn(generic(T : Type, E : Type.Struct), action : Impl(Fn(e : E) -> T)) -> Impl(Future(T, E))),
```

so the same hole lets `io.async` be handed something that is not a closure. This
passes `yo check` with rc=0:

```rust
{ println } :: import("std/fmt");

noparam :: (fn(io : Io) -> Impl(Future(i32)))(
  io.async({
    w := i32(5);
    w
  })
);

main :: (fn(io : Io) -> unit)({
  v := io.await(noparam(io), io);
  println(v.to_string())
});

export(main);
```

```
$ yo check bareblock.yo
check: bareblock.yo — evaluator OK

$ yo compile bareblock.yo --optimize 2 -o bareblock.out
bareblock.out.c:4053:88: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4054:94: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4056:42: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4059:62: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4062:60: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4069:74: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
bareblock.out.c:4101:3: error: non-void function 'yo_id_7473' should return a value [-Wreturn-mismatch]
7 errors generated.
yo: error: compile: C compiler failed (exit 1) on bareblock.out.c
```

Replacing the block with a literal — `io.async(i32(5))` — gives byte-identical
errors, which is the proof that nothing about the *block* is special: the
parameter simply is not checked.

The block is not deferred into a future either. The emitted C runs it eagerly in
the enclosing function and then returns nothing:

```c
static inline _file____priv_temp_9305_sync_fut_t* yo_id_7473(__yo_t10 io) {
  int32_t _file____priv_temp_9304;
  { // begin block
    int32_t w = 5;
    _file____priv_temp_9304 = w;
  } // end begin block
  return /* Error: no closure FUNCTION for io.async sync path */;
}
```

So even if that C compiled, the semantics would be wrong. A bare block containing
a real `io.await` behaves identically — same seven errors — so the await analysis
never sees the block at all.

The annotated forms are unaffected: `io.async((e : Io) => { w := i32(5); w })`
compiles with 0 errors and prints `5`.

The invalid-C half of Symptom 2 has a second, independent cause inside codegen; it
is filed separately as
`issues/io-async-sync-path-returns-a-c-comment-and-orphans-its-future-typedef.md`.
Fixing the evaluator hole described here makes that codegen path unreachable from
source, but it stays reachable from any other defect that loses the closure's
`FuncVal`, so both want fixing.

## Root cause

`Impl(Fn(...))` lowers to a `SomeT` carrying a `Fn` required trait, and nothing
on the call path tests the argument against that constraint.

Measured with the built-in trace: `YO_DEBUG_PARAMCHECK=1 yo check implfn.yo`
prints 4987 `[param-check]` lines and **not one of them is `label=f`** — the
Step-8 compatibility test in `check_if_function_parameter_matches_argument`
(`src/evaluator/calls/helper.yo:1056-1066`, the `are_types_compatible(final_pt,
arg_type)` throw) never runs for that parameter, even though
`try_to_call_function_with_arguments` calls it for every argument
(`src/evaluator/calls/helper.yo:6051`, and `:5984` for omitted optional
parameters). The body's own `f(i32(3))` call *is*
traced — `[param-check] label=x declared=i32 final=i32 arg=i32 compat=true` — so
by the time the body is checked, `f` has already been bound to `i32` and the
"call" looks like a well-typed `i32 -> i32` application.

So the `Fn`-constrained parameter is bound through a route that skips the
ordinary per-argument compatibility step, and that route carries no constraint
test of its own. **Whoever fixes this must first identify that route** (start at
`try_to_call_function_with_arguments`' Step-6 placeholder handling and the
generic/specialization dispatch in `src/evaluator/calls/function.yo`); the
symptom is not a wrong verdict from `are_types_compatible`, it is a verdict never
asked for.

`io.async` reaches the same place through the same door: its `action` parameter
is an ordinary `Impl(Fn(e : E) -> T)` slot, and the one structural inspection of
the argument — `_io_async_closure_param_is_annotated`
(`src/evaluator/calls/helper.yo:4645`) — only asks whether the closure's
*parameter* is annotated. Its `.Atom(_, _) => false` arms mean a non-closure
argument silently takes the un-annotated path instead of being rejected.

## Fix

Reject a non-`Fn` argument against an `Impl(Fn(...))` parameter in the evaluator,
before the parameter is bound.

1. Find the binding route the trace shows is being taken (above) and add the
   constraint test there — or, better, make that route go through
   `check_if_function_parameter_matches_argument` like every other parameter, so
   there is one place where an argument is checked.
2. The predicate already exists: `type_implements_fn`
   (`src/evaluator/trait_checking.yo:1400`). Require that an argument bound to a
   `SomeT` whose required traits include `Fn` has a `Func` type (or a type with a
   `Call` member, for callable modules). The message to mirror is
   `src/evaluator/types/field.yo:543`, which already names `Dyn(Fn(...))` and the
   generic-type-parameter alternative when it rejects `Impl(Fn(...))` as a field
   type.
3. Give the new message an E-code in `src/diagnostics.yo` plus an explain entry
   in `src/diagnostics_registry.yo` — this family has none today.
4. `io.async` then needs no special case: a bare block is an ordinary non-`Fn`
   argument and is rejected at the `io.async` call site with the same message.
   The bare form appears NOWHERE in the tree
   (`grep -rn 'io\.async({' docs/ .github/ std/ src/ tests/` → 0 hits), so
   nothing depends on it.

The mirror-image hole — a bare `fn(...)` (function-pointer) parameter accepting a
CLOSURE — is already filed as
`issues/bare-fn-type-param-accepts-a-closure-then-emits-invalid-c.md` and wants
the same treatment at the same choke point; do the two together.

Do not "fix" this in codegen with a `codegen_fatal`. The evaluator is the only
place that can name the source mistake, and `yo check` is the gate that has to
stop it — this is squarely the "`check` is not a real gate" family the sibling
doc names.

## Regression test

`tests/impl_fn_field_rejection.test.yo` already owns the "reject a bad
`Impl(Fn(...))` position" family. Add the argument-position arms there (or in a
sibling `tests/impl_fn_argument_rejection.test.yo`), each verified RED first:

- `apply(i32(5))` against `f : Impl(Fn(x : i32) -> i32)` — the error must name
  `Fn` and `i32`.
- `apply(String.from("nope"))` — the case the C compiler currently catches, so
  the Yo-level rejection is what the test pins.
- `io.async({ w := i32(5); w })` — a bare block where the closure belongs.
- `io.async(i32(5))` — a plain value.

Plus an over-rejection canary in the same file that must still PASS: the legal
argument shapes for an `Impl(Fn(...))` parameter — an inline closure, an
annotated closure, a named top-level function, and a callable module — and
`io.async(e => ...)`, `io.async((e : Io) => ...)`, `io.async((e : IoExn) => ...)`.
`tests/async_await.test.yo` and `tests/async_unit_tail_await.test.yo` are the
existing coverage for the `io.async` half and must stay green.

## Breaking change

Yes, in the narrow sense that a program the compiler accepts today would stop
compiling. Every such program is already broken (it crashes at runtime, or fails
in the C compiler), and the shape occurs nowhere in `std/`, `src/`, `tests/` or
`docs/`. Call it out in the release notes of the patch release that carries it.
