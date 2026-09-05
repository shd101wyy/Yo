# An `Impl(Fn(...))` parameter accepts a non-callable argument — the integer is cast to a function pointer and called

**Status: FIXED** 2026-09-05 (audit row C67, PR #431). Root cause: the `Fn`
constraint of an `Impl(Fn(...))` parameter lives on the parameter's `SomeT`, and
**both** call paths bind the argument's type INTO that type variable before
anything tests it — so by the time a compatibility check runs, the parameter type
IS the argument type and the check is trivially satisfied. Fixed by testing the
constraint at both binding sites, BEFORE the type variable is bound. Details in
"Root cause (measured)" and "The fix as landed" below.

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

## Root cause (measured)

`Impl(Fn(...))` lowers to a `SomeT` carrying an `Fn` required trait
(`src/evaluator/builtins/impl_constraint.yo` — the wrapper's reserved name is
`Impl`). The constraint therefore lives ON the type variable, and it is never
consulted at a call site: **the argument's type is synthesized INTO the type
variable, which destroys the evidence before any compatibility test runs.**

There are TWO binding routes, and both had the hole for a different reason.

**Route A — the inline `FuncVal` arm (`src/evaluator/calls/function.yo`).**
`YO_DEBUG_PARAMCHECK=1 yo check implfn.yo` prints 4949 `[param-check]` lines and
**not one is `label=f`**: `apply(i32(5))` never reaches
`check_if_function_parameter_matches_argument` at all. It is bound by the
parameter-binding loop of `evaluate_function_call`'s inline `FuncVal` arm, which
does carry an argument-type check — but that check is gated
`fv_forall_arg_exprs.is_some() && !type_contains_some_type_deep(resolved_decl_pt)`
(the explicit-call-site-generic case), and an `Impl(Fn(...))` parameter IS a
`SomeT`, so it was skipped every time. Its sibling check in
`_evaluate_funcval_runtime_call` (`issues/fixed/yo-self-arg-type-check-bypassed.md`)
skips every `SomeT` parameter for the same reason. The same route binds a METHOD
call's closure parameter, so `h.apply(i32(5))` was accepted too.

**Route B — `check_if_function_parameter_matches_argument`
(`src/evaluator/calls/helper.yo`).** `io.async` DOES reach it, and the trace shows
the check passing on a lie:

```
[param-check] label=action declared=Impl : (Fn(E) -> T) final=i32 arg=i32 compat=true
```

Step 6 (`synthesize_types`) binds the `Impl(Fn(e : E) -> T)` type variable to the
argument's type, Step 7 re-evaluates the parameter type in that env — so
`final_pt` becomes `i32` — and Step 8 then compares `i32` against `i32`. The
verdict was never wrong; it was asked about the wrong pair of types.

The original filing's guess that `_io_async_closure_param_is_annotated`
(`helper.yo`) was the miss is a red herring: it only chooses between two closure
shapes and is reached after the parameter is already bound.

## The fix as landed

One predicate, applied at both binding sites BEFORE the type variable is bound.

1. `src/evaluator/trait_checking.yo` gains three exported helpers:
   - `fn_constrained_param_requires_callable(param_type)` — `is_some_type(t) &&
     type_implements_fn(t)`, i.e. the `Impl(Fn(...))` family (including
     `Impl(Fn(io : Io) -> unit, Send)` and a `where(F <: Fn(...))` variable once
     the constraint is attached);
   - `type_is_callable_shaped(ty)` — LIFTED VERBATIM from the predicate the
     valueless-callee gate in `evaluate_function_call` already uses before it
     rejects `No matching call found` (`cvl_is_fnish`), so the argument side is
     judged by exactly the same rule as the callee side: a `Func`, any `SomeT`
     (unresolved, so not PROVEN non-callable), a `Type`-hierarchy type, anything
     carrying an `Fn` trait (`Impl(Fn)`, `Dyn(Fn)`, a bare `FnTraitT`), or a
     closure CAPTURE struct (`capture_<id>`) — a closure forwarded through a
     specialized parameter is statically typed as its capture struct;
   - `fn_argument_not_callable_message(...)` — one spelling of the diagnostic.
2. Route A: the parameter-binding loop in `evaluate_function_call`'s inline
   `FuncVal` arm (`calls/function.yo`), beside the existing explicit-generic
   check.
3. Route B: `check_if_function_parameter_matches_argument` (`calls/helper.yo`),
   as a new **Step 3b** — after the argument is evaluated and comptime-coerced,
   before Step 6 synthesis.
4. Both sites also accept an argument whose `ExprInfo` carries a `capture_type`
   or whose value is a `FuncVal`, so a closure is accepted on three independent
   channels.
5. Both sites `flag_flow_violation` before the throw (the C18/C19 pattern), so a
   def-time body swallow re-raises the error at `check` time instead of leaving a
   hollow body. Without it, symptom 1 stays green under `check` — the bad call
   lives inside `main`'s body, which is evaluated behind the def-eval wall.
6. New diagnostic code **E0606** (`E_ARGUMENT_NOT_CALLABLE`, `src/diagnostics.yo`),
   classified on the substring `is not callable` (`src/error.yo`), with a
   bilingual `yo explain` entry (`src/diagnostics_registry.yo`).

`io.async` needed no special case, exactly as predicted: its `action` parameter
is an ordinary `Impl(Fn(e : E) -> T)` slot.

The mirror-image hole — a bare `fn(...)` (function-pointer) parameter accepting a
CLOSURE — is still open as
`issues/bare-fn-type-param-accepts-a-closure-then-emits-invalid-c.md`; it wants
the same treatment at the same two sites.

## Verification

Before → after, with a stage-1 built from this tree:

| program | before | after |
| --- | --- | --- |
| `apply(i32(5))` (symptom 1) | `check` OK, links, **rc=138 SIGBUS** | `error[E0606] Argument for parameter "f" is not callable` |
| `apply(String.from("nope"))` | `check` OK, C compiler error | E0606, naming `String` |
| `h.apply(i32(5))` (method) | `check` OK | E0606 |
| `io.async(i32(5))` (symptom 2) | `check` OK, 7 C errors | `error[E0606] … parameter "action" …` |
| `io.async({ w := i32(5); w })` | `check` OK, same 7 C errors | E0606 |

Over-rejection canaries, all compiled AND RUN under the stage-1: inline closure,
`->` arrow literal, a top-level `::` fn passed by name, an explicit
`(fn(x : i32) -> i32)(...)` literal, a `ClosureType({...})` value, a capturing
closure bound to an annotated local, a method's closure parameter, a closure
FORWARDED from one `Impl(Fn)` slot into another (twice), `dyn(...)` into a
`Dyn(Fn)` parameter, `Option.map`, and `io.async(e => …)` /
`io.async((e : Io) => …)` / `io.async((e : IoExn) => …)`.

Gates: `check ./src` 266/266, `check ./std` 173/173, `compile src/main.yo
--skip-c-compiler` clean, `yo build` green, and the full language suite green —
all under the stage-1 carrying the change.

Two shapes that USED to reach `check` and now do not, both of which already
emitted uncompilable C (verified against the v0.2.24 seed, so this is a
diagnostic upgrade, not a regression): a struct with an inherent `Call` method,
and a callable MODULE, passed to an `Impl(Fn(...))` parameter.

## Regression tests

- `tests/impl_fn_field_rejection.test.yo` — the file already owned the "reject a
  bad `Impl(Fn(...))` position" family; it gained the argument-position arms
  (`apply(i32(5))`, ``apply(`nope`)``, `h.run(i32(5))`, `io.async(i32(5))`,
  `io.async({ … })`) plus two over-rejection canary tests. Verified RED first:
  under the v0.2.24 seed the new arms fail with `Expected compile error, but the
  expression was evaluated successfully`.
- `tests/cli-cases/check-impl-fn-arg-not-callable/` and
  `tests/cli-cases/check-io-async-arg-not-callable/` — `check` must exit 1 with a
  `stdout_keep_match` naming the parameter, one case per call route.
- `tests/internal/error.test.yo` — the classifier maps the message to E0606.
- `tests/internal/diagnostics_registry.test.yo` — E0606 has a bilingual entry.

## Breaking change

Yes, in the narrow sense that a program the compiler accepted before would stop
compiling. Every such program was already broken (it crashed at runtime, or
failed in the C compiler), and the shape occurs nowhere in `std/`, `src/`,
`tests/` or `docs/`. Call it out in the release notes of the patch release that
carries it.
