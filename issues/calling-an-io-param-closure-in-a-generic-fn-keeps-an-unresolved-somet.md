# Calling an `Impl(Fn(io : Io) -> T)` parameter inside a generic function types the result as an unresolved `SomeT` — the C is invalid and nothing says so

**Status: OPEN.** Severity: **silent invalid C** (undeclared symbol / link
failure / hard clang type error, depending on `T`), plus a latent **32-bit
truncation** on `wasm32-wasip1`. `yo check` is green, the emitted `.c` carries
**zero** `// Failed to transpile` markers, and only the C compiler — or, on
wasm32, nothing at all — notices.

Found 2026-09-04 during the std-API-audit re-measurement of the `std/thread`
`join() -> T` row, at v0.2.24.

This is the surviving half of
`issues/fixed/spawn-closure-generic-captures-erased-to-void-ptr.md`, whose
"FIXED BY EVENTS" status is only half right. Re-measured at v0.2.24: that doc's
own repro `issues/repros/spawn-closure-generic-capture-void-ptr.yo` does
compile and run (rc 0), so the `void*` **capture-struct field** really is
fixed. But the second symptom the same doc lists —

> Calling a captured generic closure has the same shape — the result temp is
> declared `void*`:
> `void* _file____User_temp_9326 = closure_yo_id_7419(&(((__yo_t21*)closure_context)->cb), io);`

— is not fixed, and neither is the broken row of its own boundary table
("mangled name keeps the unresolved SomeT id, e.g. `_1869_`"). Both reproduce
below; the mangle in Reproducer 1 even carries the same `_1869_` id.

**`Thread.spawn` is NOT the trigger.** The measurement that produced that doc
only ever exercised the shape through `Thread.spawn`, so the framing stuck. It
is wrong: the identical failure occurs with no thread, no `std/sync`, and no
spawn anywhere (Reproducer 1), and the identical spawn program **passes** when
the callback takes an `i32` instead of an `Io` (boundary row 6). The trigger is
the closure parameter's own type being `Io`.

## Reproducer 1 — minimal, 22 lines, no threads

`issues/repros/io-param-closure-result-unresolved-somet.yo` (source inline below — commit it at that path alongside this doc):

```rust
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
Cell :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(struct(v : T));
impl(
  generic(T : Type),
  where(T <: Send),
  Cell(T),
  put : (fn(inout(self) : Self, value : T) -> unit)({
    self.v = value;
  })
);
run :: (fn(generic(T : Type), io : Io, seed : T, cb : Impl(Fn(io : Io) -> T), where(T <: Send)) -> T)({
  b := Cell(T)(v : seed);
  b.put(cb(io));
  b.v
});
main :: (fn(io : Io) -> unit)({
  a := run(io, i32(0), (io2 : Io) => i32(42));
  assert(a == i32(42), "42");
  println("ok");
});
export(main);
```

```
$ yo check issues/repros/io-param-closure-result-unresolved-somet.yo
... evaluator OK   (rc 0)

$ yo compile issues/repros/io-param-closure-result-unresolved-somet.yo --optimize 2 -o /tmp/r1.out
Using system allocator
/tmp/r1.out.c:1592:9: warning: incompatible integer to pointer conversion initializing 'void *' with an expression of type 'int32_t' (aka 'int') [-Wint-conversion]
 1592 |   void* _file____priv_temp_11574 = closure_yo_id_10256(&(cb), io);
      |         ^                          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
/tmp/r1.out.c:1596:3: warning: call to undeclared function 'yo_id_10247_rtparam0_gs_yo_id_10243_i32_rtparam1_1869_ret_unit'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
 1596 |   yo_id_10247_rtparam0_gs_yo_id_10243_i32_rtparam1_1869_ret_unit((&(b)), _file____priv_temp_11574);
      |   ^
2 warnings generated.
Undefined symbols for architecture arm64:
  "_yo_id_10247_rtparam0_gs_yo_id_10243_i32_rtparam1_1869_ret_unit", referenced from:
      ___yo_user_main in r1-3cbbf4.o
ld: symbol(s) not found for architecture arm64
clang: error: linker command failed with exit code 1 (use -v to see invocation)
yo: error: compile: C compiler failed (exit 1) on /tmp/r1.out.c
```

Expected: `ok`, rc 0.

Two independent things are wrong in those two emitted lines, and they have one
cause:

1. `void* _file____priv_temp_11574 = closure_yo_id_10256(...)` — the temp for
   `cb(io)` is declared `void*`, while the callee's own emitted prototype three
   pages up is `static inline int32_t closure_yo_id_10256(void* closure_context, __yo_t11 io2);`.
   One emitted file disagrees with itself.
2. `..._rtparam1_1869_...` — `1869` is a raw `SomeT` id sitting in the mangled
   name of `Cell(T).put` where `i32` belongs. That specialization is **called
   once and defined zero times**
   (`grep -c yo_id_10247_rtparam0_gs_yo_id_10243_i32_rtparam1_1869 => 1`).

## Reproducer 2 — the shape the `std/thread` `join() -> T` row actually needs

`issues/repros/spawn-generic-closure-result-into-channel-send.yo` (source inline below):

```rust
pragma(Pragma.AllowUnsafe);
{ Channel } :: import("std/sync/channel");
{ Thread } :: import("std/thread");
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
run :: (fn(generic(T : Type), cb : Impl(Fn(io : Io) -> T, Send), where(T <: (Send, Acyclic))) -> T)({
  ch := Channel(T).new(usize(1));
  t := Thread.spawn((io : Io) => {
    ch.send(cb(io));
    ()
  });
  t.join();
  match(ch.recv(), .Some(v) => v, .None => __yo_panic("no value"))
});
main :: (fn() -> unit)({
  a := run((io : Io) => i32(42));
  assert(a == i32(42), "42");
  println("ok");
});
export(main);
```

```
$ yo compile issues/repros/spawn-generic-closure-result-into-channel-send.yo --optimize 2 -o /tmp/r2.out
/tmp/r2.out.c:2807:9: warning: incompatible integer to pointer conversion initializing 'void *' with an expression of type 'int32_t' (aka 'int') [-Wint-conversion]
 2807 |   void* _file____priv_temp_13461 = closure_yo_id_11632(&(((__yo_t21*)closure_context)->cb), io);
/tmp/r2.out.c:2811:39: warning: call to undeclared function 'yo_id_10729_rtparam0_R_gs_yo_id_10693_i32_rtparam1_1944_ret_enum_yo_id_10728_value_unit_error_i32'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
 2811 |   __yo_t18 _file____priv_temp_13546 = yo_id_10729_rtparam0_R_gs_yo_id_10693_i32_rtparam1_1944_ret_enum_yo_id_10728_value_unit_error_i32(((__yo_t21*)closure_context)->ch, _file____priv_temp_13461);
/tmp/r2.out.c:2811:12: error: initializing '__yo_t18' (aka 'struct __yo_t18_struct') with an expression of incompatible type 'int'
2 warnings and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/r2.out.c
```

`Channel(T).send`'s value parameter is mangled `rtparam1_1944` — an unresolved
`SomeT` where `i32` belongs — and is never defined.

## Measured boundary (v0.2.24, `--optimize 2`, `--std-path ./std`)

| # | shape | result |
| --- | --- | --- |
| 1 | generic fn, `cb : Impl(Fn(io : Io) -> T)`, `m.method(cb(io))` | **BROKEN** — Reproducer 1 |
| 2 | same, with an explicit `(r : T) = cb(io); m.method(r);` | **BROKEN** — identical mangle; the emitted C declares `void* r` |
| 3 | same, inside a `Thread.spawn` closure, into `Channel(T).send` | **BROKEN** — Reproducer 2 |
| 4 | generic fn, `cb : Impl(Fn() -> T)` (no parameter at all) | OK |
| 5 | generic fn, `cb : Impl(Fn(n : i32) -> T)` | OK — temp is `int32_t` |
| 6 | Reproducer 2 verbatim but `cb : Impl(Fn(n : i32) -> T, Send)` | OK, runs, prints `42` |
| 7 | generic fn, `cb : Impl(Fn(a : ArrayList(i32)) -> T)` | OK |
| 8 | generic fn, param a user struct with a generic-fn field, or a nested `Impl(Fn)` field, or a `!(Send())` impl | OK |
| 9 | NON-generic driver, `cb : Impl(Fn(io : Io) -> i32)` | OK — healthy `..._rtparam1_i32` |
| 10 | generic fn, `Impl(Fn(io : Io) -> T)` called and its result **discarded** | OK |

Rows 4–8 are the important ones: reproducing `Io`'s structure in a user type
(generic function fields, a nested `Impl(Fn(...))` carrier, a negative `Send`
impl) does **not** trigger it. Row 9 shows the enclosing function must be
generic; row 10 shows the result must be USED.

## The failure changes shape with `T`, and one shape is silent

All four bullets below are the SAME defect at different `T`, measured
through the `Io`-parameter path above (with an `i32`-taking callback all
four instantiations compile and run, including `T = unit`).

* `T = i32` / any pointer-width integer — `void*` temp is an
  `-Wint-conversion` **warning**; the hard failure comes from the SomeT-mangled
  callee. On a compiler that permits implicit declarations this would link
  against whatever happens to exist.
* `T = f64` — a hard error with no downstream call at all:
  `error: initializing 'void *' with an expression of incompatible type 'double'`
  and `error: assigning to 'double' from incompatible type 'void *'`.
* `T = unit` — `error: initializing 'void *' with an expression of incompatible
  type 'void'` (the callee returns C `void`, the temp is still declared
  `void*`). This is what stops `Thread.spawn` from simply being made generic in
  `T`: Yo has no function overloading
  (`plans/FUNCTION_OVERLOADING_POLICY.md`), so there can be only one
  `Thread.spawn`, its callback is `Fn(io : Io) -> T` by construction, and every
  existing call site is `T = unit`.
* **`T = u64` or `i64` compiles clean and is wrong on 32-bit targets.** The
  value round-trips `uint64_t -> void* -> uint64_t`, which is lossless only
  because `void*` is 64 bits here. The same program emitted for
  `--target wasm32-wasip1` still contains

  ```c
  static inline uint64_t closure_yo_id_11576(void* closure_context, __yo_t14 io);
  ...
  void* _file____priv_temp_13271 = closure_yo_id_11576(&(((__yo_t13*)closure_context)->cb), io);
  (*((__yo_t13*)closure_context)->slot) = _file____priv_temp_13271;
  ```

  where `void*` is 32 bits — the top half of every `u64`/`i64`/pointer-pair
  result is discarded, silently, with no diagnostic on any layer.

## Root cause

The chain is four links; links 2–4 are read off the source, link 1 is measured
in the emitted C.

**1. The call's result type stays an unresolved `SomeT`.** `cb(io)`'s
`ExprInfo.ty` is the enclosing generic's `T` (id `1869` / `1944` above) with an
empty resolution cell. `get_type_string` walks that cell
(`resolve_some_type_to_concrete`, `src/codegen/exprs/closures.yo:67-107`, over
`SomeT.resolved_concrete` and the id registry
`g_some_resolved_concrete` / `lookup_some_resolved_concrete`,
`src/expr_info.yo:979-998`) and, finding nothing, lowers it to `void*`.

The closure literal takes the `=>` lambda-argument path
(`src/evaluator/values/anonymous_function.yo`; the `YO_DEBUG_CAPTURE`
`[fbctx-closure-call]` probe never fires, so `closure_type.yo`'s
`try_to_implement_closure_by_fn_module_type` is not involved). That path DOES
carry a return-refinement — `_synth_nested_return_somes` plus the
`function_type` rebuild at `anonymous_function.yo:1599-1651`, and the
`mark_closure_for_codegen` re-registration at `:1681-1734` — and it visibly
works, because the closure's own emitted prototype is `int32_t`. What does not
happen is the corresponding write into the DECLARED parameter type's `T` cell,
which is what the call site `cb(io)` reads.

**Not isolated:** why an `Io`-typed closure parameter defeats that write and an
`i32` / `ArrayList(i32)` / generic-fn-field-struct one does not. `Io` is not
matched by name anywhere in the evaluator (`grep -rn '"Io"' src/` gives three
hits, none on this path), so it is a structural property. The two candidates
worth checking first are the io-builtin field marking
(`record_io_builtin_struct_field`, `src/evaluator/calls/function.yo:3568-3612`
— `Io`'s four fields are `__yo_io_async` / `__yo_io_await` / `__yo_io_state` /
`__yo_io_spawn`, `std/prelude.yo:10359-10389`) and the effect-bundle argument
handling around `io_builtin_skip_expected`
(`src/evaluator/calls/helper.yo:5915-5930`). Rows 4–8 of the boundary table
rule out the obvious structural explanations.

**2. The unresolved `SomeT` becomes the next callee's specialization key.**
`evaluate_function_call` records each argument as
`ArgEntry(value : ainfo.value, parameter_type : ainfo.ty, arg_type : arg_ty_spec)`
(`src/evaluator/calls/function.yo:2385`), and the soft-generic specialization
trigger reads `evaled_arg_infos[i].ty` when it decides concreteness
(`ou_spec_soft_generic` / `ou_sg_all_concrete`,
`src/evaluator/calls/function.yo:2163-2186`). The specialization of the
receiving method (`Cell(T).put`, `Channel(T).send`) is therefore minted with a
raw `SomeT` in that parameter slot — which is exactly what `_rtparam1_1869_`
is. Note the RETURN of the same specialization resolved correctly
(`..._ret_enum_..._error_i32`): only the argument-derived slot is poisoned.

**3. Codegen then DROPS the definition of that specialization.**
`should_skip_function_codegen` (`src/codegen/functions/declarations.yo:483`)
computes `has_generic_params` from `_func_has_generic_params`
(`:412-430`, `:529`) and skips anything whose parameter types still contain a
`SomeT` (`skip2`, `:547`). So the call survives and the definition does not.

**4. Nothing degrades the call, so the failure is silent.** The
registered-FuncVal call path already guards against exactly this: it calls
`should_skip_function_codegen` and, on a hit, emits
`// Failed to transpile ...` instead of a call
(`src/codegen/exprs/other_fn_call.yo:1930-1931`). The **dot-method dispatch
path** — which is what `b.put(...)` and `ch.send(...)` take — resolves the
callee's C name through `_c_func_name(mfid2, context)` at
`src/codegen/exprs/other_fn_call.yo:1156-1160` and emits the call with **no
such check**. That is why `grep -c "Failed to transpile"` is 0 on every
reproducer here and `scripts/count-transpile-failures.sh` scores the file
clean.

## Fix

**Primary (link 1) — resolve the closure parameter's declared result type.**
When a `=>` closure argument's body type refines the expected `Impl(Fn(...) -> T)`
carrier's result, the binding must reach the DECLARED parameter type's `T`
cell, not only the closure's own re-registered `Func` type. The machinery
already exists — `register_some_resolved_concrete`
(`src/expr_info.yo:981`) is what
`src/evaluator/calls/closure_type.yo:330` uses for the closure WRAPPER SomeT,
and `src/evaluator/calls/helper.yo:2928-2940` uses for the per-spec capture
rebind. Extend that to the Fn-trait's RESULT SomeT at the same site, and the
`Io` special case disappears with it (rows 4–8 already take this route
successfully; the fix is making row 1 take it too).

First step for whoever picks this up: instrument
`anonymous_function.yo:1599-1651` and print `nrs_ret_ty` / `nrs_body_ty` /
whether the gate fires, for Reproducer 1 (broken) against the same file with
`Impl(Fn(n : i32) -> T)` (working). Those two differ in one token, so the
divergence is a single branch.

**Secondary (link 4) — make this class loud, not silent.** Add the same
never-emitted-callee guard the FuncVal path has at
`other_fn_call.yo:1930-1931` to the dot-method dispatch path at
`other_fn_call.yo:1156-1190`: if `should_skip_function_codegen` is true for the
resolved method's `func_id`, emit the statement-level
`// Failed to transpile ...` marker instead of a call to an undeclared symbol.
Do this even after the primary fix lands — it is the difference between a
hollow marker the sweep counts and a linker error nobody attributes.

Do **not** "fix" this by making the temp's C type follow the callee's emitted
prototype: that would paper over link 2, leaving `Cell(T).put` still keyed on a
`SomeT` and still undefined.

## Why the `std/thread` result-carry row is blocked on this

`plans/HANDOVER_STD_AUDIT_NEXT.md` item 12 records `join() -> T` as unblocked
because `issues/fixed/spawn-closure-generic-captures-erased-to-void-ptr.md`
measured fixed. It is not. `Thread.spawn`'s callback is
`Impl(Fn(io : Io) -> unit, Send)` (`std/thread.yo:57`), so a result-carrying
`spawn` is generic in `T` over a callback that takes an `Io` — precisely
Reproducer 2. Every route out of the thread that hands the callback's result to
a generic method (`Channel(T).send`, an `Atomic(T)` store, a slot wrapper) hits
this. The raw `*(T)` pointer-slot route currently compiles for
pointer-width `T` only, by accident, and truncates on wasm32 (see above).

## Regression test

`tests/forwarded_closure_param_spec.test.yo` is the right home — it already
covers closure parameters forwarded through specializations. Add three cases,
each verified RED first:

1. Reproducer 1 verbatim, asserting the value comes back (`42`). Today: link
   failure.
2. The same with `T = f64` and `T = unit` in one program — the two shapes that
   are hard clang errors rather than warnings.
3. The same generic driver instantiated at `T = i32` **and** `T = u64` in one
   program, asserting both values, so the specialization-collision case is
   pinned alongside.

`tests/thread.test.yo` should get Reproducer 2 once the compiler fix lands (it
is the API `std/thread.yo:11-25` tells users to write, and no test exercises
it).

Note `yo check` cannot gate any of these — it is evaluator-only and all four
reproducers pass it. The test must be a compile-and-run case.

## Status corrections this issue implies

* `issues/fixed/spawn-closure-generic-captures-erased-to-void-ptr.md` — the
  "FIXED BY EVENTS / therefore unblocked" header contradicts the doc's own
  boundary table and its "Why this blocks `join() -> T`" section. Narrow it to
  the capture-struct half and point it here.
* `plans/HANDOVER_STD_AUDIT_NEXT.md` item 12 and
  `plans/STD_API_AUDIT.md` D7 — the row is BLOCKED, on this.
