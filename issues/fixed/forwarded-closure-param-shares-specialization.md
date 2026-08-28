# Two helpers forwarding different capturing closures to one function shared ONE specialization — `(__yo_t18)(make)` where `make` is `__yo_t19`

**Status: FIXED 2026-08-29** — two halves: the specialization cache key
(`src/evaluator/calls/helper.yo`) and the dead-original emission
(`src/function_value.yo` side table, `src/codegen/functions/collection.yo`,
`src/codegen/functions/declarations.yo`). **Found:** 2026-08-29 while writing S5 coverage
tests for `std/log`'s `*_lazy` family: `log.debug_lazy(c1); log.trace_lazy(c2)`
with two closures capturing the same `ArrayList` failed to compile.
**Severity:** HIGH — a C type error when the capture structs differ in type
name only, and a SILENT wrong-closure call whenever two capture structs happen
to be layout-identical AND the compiler accepts the cast.

## Reproducer

`fwdmod.yo`:

```rust
Lv :: enum(A, B, C);
inner :: (fn(lv : Lv, make : Impl(Fn() -> String)) -> unit)(cond(on(lv) => println(make()), true => ()));
outer_a :: (fn(make : Impl(Fn() -> String)) -> unit)(inner(Lv.A, make));
outer_b :: (fn(make : Impl(Fn() -> String)) -> unit)(inner(Lv.B, make));
```

```rust
m :: import("./fwdmod.yo");
seen := ArrayList(i32).new();
m.outer_a(() => { seen.push(i32(1)); String.from("a") });
m.outer_b(() => { seen.push(i32(2)); String.from("b") });
```

```
error: used type '__yo_t18' (aka 'struct __yo_t18_struct') where arithmetic or pointer type is required
  yo_id_6894_..._rtparam1_1831_ret_unit((__yo_t6)(__YO_T6_B), (__yo_t18)(make));   // inside outer_b, whose make is __yo_t19
```

Both closures capture `seen : ArrayList(i32)`, so their capture structs are
structurally identical (anonymous names, one field of one type).

## Mechanism (two independent halves)

**1. Cache key (evaluator).** `create_specialized_function_inline` folds a
closure's identity into the cache key only when the ARGUMENT'S VALUE is a
`FuncVal` (a closure literal: `clfid<i>_<func_id>`). A forwarded closure PARAM
has no value, so nothing was added; the cache lookup then compared the runtime
param types with `are_types_compatible_exact`, and two capture structs with
identical fields and empty names are exact-equal under the struct arm's
structural rule. The second helper's `inner(Lv.B, make)` could therefore find
`outer_a`'s specialization. Closure literals were already protected against
exactly this (`issues/repros/arc-spawn-capture-split.yo`); the forwarded-param
face was not.

**2. Dead original (codegen) — the half that produced the C error in the
reproducer.** Tracing `record_method_callee_value` showed every helper AND
every inner call already received its own, correct specialization, and `main`
called them. The `(__yo_t18)(make)` lines were in an EXTRA function: the
UNSPECIALIZED original `yo_id_6910(__yo_t18 make)`. For a dot call
`m.outer_a(closure)` the evaluator records the specialization only in the
method-callee side table; the callee expression `m.outer_a` keeps the
original FuncVal in its ExprInfo, and `collection.yo`'s callee-ExprInfo arm
collected and emitted it. Its `Impl(Fn)` param renders as whatever capture
struct the SomeT cell last held, and its body calls the def-era `inner`
specialization — dead code that only type-checks while a single closure
shape flows through the helper. With an OPEN import (atom callee) the
evaluator restamps the atom's value with the specialization, which is why the
same module compiled under `open(import(...))` and failed under `m :: import(...)`.

## Fix

1. For an argument without a `FuncVal`, resolve its type
   (`_spec_resolve_arg_ty`) and, when it is a `capture_*` struct, push
   `clcap<i>_<struct id>` onto the compile-time-arg key
   (`_push_forwarded_closure_key`); `_find_specialization_cache` additionally
   treats two `capture_*` struct ids that differ as a non-match
   (`cap_ids_differ`).
2. `create_specialized_function_inline` records the ORIGINAL func_id it
   minted a specialization from (`mark_fn_specialized` /
   `fn_has_specializations`, `src/function_value.yo`). An original that has
   specializations AND whose signature still carries a SomeT param under a
   RAW scan (`func_params_have_raw_some_type`, `src/types/utils.yo` — the
   resolution cell is deliberately not consulted, unlike
   `type_contains_some_type`) is generic-unspecialized:
   `_is_generic_unspecialized_func` (collection) stops collecting it, and
   `should_skip_function_codegen` (declarations) refuses to emit it even when
   a module-namespace or registry path registered it. Labelling every
   `register_function` site showed the original reached codegen through
   several of them (the by-label module-member path first, then others once
   that was gated), so a per-site gate was the wrong shape — the emission
   gate is the single source of truth. Effect-record members are exempt, as
   for the hard-generic skip (type-erased, emitted).

## Regression test

`tests/forwarded_closure_param_spec.test.yo` over
`tests/closure_forward/mod.yo` — three helpers forwarding closures with the
same capture shape, plus a capture-free one, each observed to run its OWN
closure.
