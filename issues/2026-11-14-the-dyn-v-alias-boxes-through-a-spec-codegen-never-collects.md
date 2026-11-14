# The `dyn(v)` alias boxes through a spec codegen never collects (no C function name)

**Severity:** S1 (blocks the d49 flip: ~1463 `dyn(v)` alias sites in src and most error-throwing tests; the flip's stage 2 cannot compile the tree until it is fixed)

**Date:** 2026-11-14

## Verbatim error

```text
p5b8.c:2508:783: error: expected expression
  ... (((__yo_t_4163876515418914838 (*)(__yo_t_7225151960912239025, __yo_t_4636743730022276490))/* Error: no C function name for func value yo_id_1352334768521580635000000_rtparam0_struct_decl_p__p5_E1_r0c6_i32_... */)((__yo_t_7225151960912239025)(...), (__yo_t_4636743730022276490){ .tag = ..._NONE }));
```

## Reproducer (`tmp/fixme.yo`; probe `tmp/p/p5.yo` on `vbd/d49-flip`)

```yo
{ Error, AnyError } :: import("std/error");
E1 :: struct(code : i32);
derive(E1, Clone, ToString);
impl(E1, Error());
f :: (fn(err : AnyError) -> i32)(
  match(downcast(&err.*, E1), .Some(e) => e.code, .None => i32(-1))
);
main :: (fn() -> unit)({
  println(&f(dyn(E1(code : i32(3)))).to_string()); // the alias: invalid C
});
export(main);
```

`dyn(Box.new(E1(code : i32(3))))` — the explicit spelling — compiles and runs
(`3`), so only the ALIAS path is broken.

## Root cause (isolated to this precision on 2026-11-14)

The alias's executing path (`src/evaluator/values/dyn.yo`, the
`_dyn_payload_is_plain_value` branch at ~1882) synthesizes a `Box.new(v,
alloc)` dot-call (`_synthesized_cell_call`'s concrete branch), evaluates it,
and records the evaluated box expression as the dyn node's rewrite
(`note_rewritten_node`) and as `runtime_arg_exprs_in_order[0]`. The
specialization of `Box(T).new` at the payload type is CREATED by that
evaluation (its spec fid is what the emitted callee carries), but it is never
registered in codegen's function table: the collector
(`find_function_calls_in_expr` over the rewritten view) reaches a path that
either skips the spec (the `expr_contains_unknown_value && _func_has_some_param`
skip in the callee-ExprInfo arm, collection.yo ~896) or never descends into the
synthesized callee, so `fn_value_c_name(spec_fid)` finds nothing and
`generate_comptime_value`'s FuncVal arm emits the error comment inside a
function-pointer cast. The explicit `dyn(Box.new(v))` works because its source
call is collected through the dot-registry arm before any of this matters.

## Next step

Instrument which arm the collector takes for the synthesized call (a
`YO_DEBUG` print at collection.yo's skip), then either drop the skip for a
fid that has a spec instantiation or make `_synthesized_cell_call`'s concrete
branch record `record_method_callee_value` the way a source dot-call does
(collection.yo:870's arm then collects it).

## Test

`tmp/p/p5.yo` (both forms); once fixed, `tests/error.test.yo`'s
`dyn(...)`-throwing rows and `tests/dyn.test.yo`'s alias rows are the
regression suite.
