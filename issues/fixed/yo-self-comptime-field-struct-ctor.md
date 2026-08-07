# yo-self: value-struct ctor with a COMPTIME-ONLY field emits a field value as a C type name

_2026-07-20. **FIXED — tests/module_struct_unification.test.yo FLIPS 10/10
(#69 +1).** One-line-ish codegen fix in other_fn_call.yo. Full battery + fixpoint
below. Diagnosis + resolution._

## Symptom

`tests/module_struct_unification.test.yo` (s2) fails C compile:

```
tests/.yo_selftest_batch_1.bin.c:5107:58: error: unexpected type name '__yo_t32': expected expression
```

at a struct constructor for a struct with a COMPTIME-ONLY field:

```rust
ConfiguredCounter :: struct(
  tag :: "configured-counter",   // comptime-only field (erased from C layout)
  next : (fn() -> i32)           // runtime field
);
make_counter :: (fn() -> ConfiguredCounter)(ConfiguredCounter(next : (() -> i32(42))));
```

Emitted (WRONG): `(__yo_t0){ .next = __yo_t0 }` — `.next` = the struct TYPE NAME.
TS emits `{ .next = fn_...id_33 }` (the closure fn pointer).

## Root cause

The value-struct constructor branch (codegen/exprs/other_fn_call.yo ~1398) pairs
the struct's RUNTIME fields (`get_runtime_struct_fields`, comptime-erased) with
`ei.runtime_arg_exprs_in_order` BY INDEX. But `runtime_arg_exprs_in_order` records
a slot for EVERY field, INCLUDING comptime-only ones. Probe `[VSCTOR]`:

```
c=__yo_t0 rtf=1 args=2
  rtf[0]=next
  arg[0]=ConfiguredCounter    <- the comptime `tag` field's slot (a struct-type expr)
  arg[1]=() -> i32(42)        <- the closure (the REAL `next` value)
```

So `rt_fields[0]=next` was paired with `args[0]=ConfiguredCounter` (a TypeVal →
`generate_comptime_value`'s TypeVal arm emits the C type name `__yo_t0`), and the
closure at `args[1]` was dropped. The object-ctor path already avoids this by
matching via `_ctor_args_from_labeled` (runtime field → labeled arg by name); the
value-struct path used the raw index-paired args.

## Fix

`other_fn_call.yo` value-struct branch: when `runtime_arg_exprs_in_order` count
≠ runtime-field count (i.e. a comptime field shifted the slots), re-derive the
runtime-field values with `_ctor_args_from_labeled(wrapped, fncall_args)` (matches
each runtime field to the ctor call's `label : value` arg by name). Normal structs
(counts equal) keep the raw args unchanged. This also gives the value-struct path
the empty-runtime-args fallback the object-ctor path already had.

## Verification (full battery, all green)

- Repro: `.next = fn_yo_id_4687` (closure pointer), clang-clean.
- `module_struct_unification.test.yo`: 10/10 (s1 + s2) — was C-compile failure.
- Corpus PASS 135 DIFF 2 SELF-FAIL 0, std 153/153, STRICT_FIXPOINT byte-identical,
  env=0. Prior flips hold (flowability 3, forward_ref 5, comptime 28, error 8,
  str 3, lexer 34, parser 49). No regression.
